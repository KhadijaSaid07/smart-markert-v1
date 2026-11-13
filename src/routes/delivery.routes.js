const express = require('express');
const bcrypt = require('bcrypt');
const db = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');
const { createAndEmitNotification, emitToUser } = require('../services/notificationService');
const { predictEtaMinutes } = require('../services/aiService');
const { haversineDistanceKm } = require('../utils/geo');

const router = express.Router();

router.use(authenticate, authorize('rider'));

/**
 * PUT /api/delivery/rider/status
 * Toggle rider online/offline and update live GPS coordinates.
 */
router.put('/rider/status', async (req, res) => {
  try {
    const { isOnline, latitude, longitude } = req.body;
    const { rows } = await db.query(
      `UPDATE users SET
        is_online = COALESCE($1, is_online),
        latitude = COALESCE($2, latitude),
        longitude = COALESCE($3, longitude),
        updated_at = NOW()
       WHERE id = $4
       RETURNING id, is_online, latitude, longitude`,
      [
        isOnline !== undefined ? Boolean(isOnline) : null,
        latitude != null ? Number(latitude) : null,
        longitude != null ? Number(longitude) : null,
        req.user.id,
      ]
    );
    return res.json({ rider: rows[0] });
  } catch (error) {
    return res.status(500).json({ message: 'Failed to update rider status.' });
  }
});

/**
 * GET /api/delivery/available?radiusKm=15
 * Geo-fenced order dispatch: returns unassigned deliveries within radiusKm of rider.
 */
router.get('/available', async (req, res) => {
  try {
    const radiusKm = Number(req.query.radiusKm) || 15;
    const { rows } = await db.query(
      `SELECT d.*, o.order_number, o.total_amount, o.payment_status,
              b.name AS business_name, b.phone AS business_phone,
              u.full_name AS customer_name
       FROM deliveries d
       JOIN orders o ON o.id = d.order_id
       JOIN businesses b ON b.id = o.business_id
       JOIN users u ON u.id = o.customer_id
       WHERE d.status = 'awaiting_rider' AND o.status <> 'cancelled'
       ORDER BY d.created_at DESC`
    );

    const rLat = req.user.latitude;
    const rLng = req.user.longitude;

    const filtered = rows
      .map((d) => {
        const pickupDist = haversineDistanceKm(rLat, rLng, d.pickup_latitude, d.pickup_longitude);
        return { ...d, rider_to_pickup_km: pickupDist };
      })
      .filter((d) => d.rider_to_pickup_km === null || d.rider_to_pickup_km <= radiusKm)
      .sort((a, b) => (a.rider_to_pickup_km ?? 999) - (b.rider_to_pickup_km ?? 999));

    return res.json({ deliveries: filtered });
  } catch (error) {
    console.error('[Available Deliveries] Error:', error);
    return res.status(500).json({ message: 'Failed to load available deliveries.' });
  }
});

/**
 * GET /api/delivery/my
 * Rider's assigned, active, and completed deliveries + earnings summary.
 */
router.get('/my', async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT d.*, o.order_number, o.total_amount, o.status AS order_status,
              b.name AS business_name, b.phone AS business_phone,
              u.full_name AS customer_name, u.phone AS customer_phone
       FROM deliveries d
       JOIN orders o ON o.id = d.order_id
       JOIN businesses b ON b.id = o.business_id
       JOIN users u ON u.id = o.customer_id
       WHERE d.rider_id = $1
       ORDER BY d.created_at DESC`,
      [req.user.id]
    );

    const walletRes = await db.query('SELECT * FROM escrow_wallets WHERE user_id = $1', [req.user.id]);
    return res.json({
      deliveries: rows,
      wallet: walletRes.rows[0] || { available_balance: 0, held_balance: 0, total_earned: 0 },
    });
  } catch (error) {
    return res.status(500).json({ message: 'Failed to load rider deliveries.' });
  }
});

/**
 * POST /api/delivery/:id/accept
 */
router.post('/:id/accept', async (req, res) => {
  try {
    const { rows } = await db.query(
      `UPDATE deliveries
       SET rider_id = $1, status = 'assigned', assigned_at = NOW(), updated_at = NOW()
       WHERE id = $2 AND status = 'awaiting_rider'
       RETURNING *`,
      [req.user.id, req.params.id]
    );

    if (rows.length === 0) {
      return res.status(409).json({ message: 'Delivery already assigned or unavailable.' });
    }

    const delivery = rows[0];
    const ordRes = await db.query(
      `SELECT o.id, o.order_number, o.customer_id, b.owner_id AS vendor_user_id
       FROM orders o JOIN businesses b ON b.id = o.business_id
       WHERE o.id = $1`,
      [delivery.order_id]
    );

    if (ordRes.rows.length > 0) {
      const ord = ordRes.rows[0];
      await createAndEmitNotification({
        userId: ord.customer_id,
        title: 'Rider Assigned',
        message: `${req.user.full_name} accepted delivery for order ${ord.order_number}. ETA ~${delivery.estimated_minutes} min.`,
        category: 'delivery',
        metadata: { orderId: ord.id, deliveryId: delivery.id },
      });
      await createAndEmitNotification({
        userId: ord.vendor_user_id,
        title: 'Rider Assigned',
        message: `Rider ${req.user.full_name} is coming to pick up order ${ord.order_number}.`,
        category: 'delivery',
      });
    }

    return res.json({ delivery, message: 'Delivery accepted.' });
  } catch (error) {
    return res.status(500).json({ message: 'Failed to accept delivery.' });
  }
});

/**
 * PUT /api/delivery/:id/pickup
 * Marks delivery as picked_up / en_route and recalculates live AI ETA.
 */
router.put('/:id/pickup', async (req, res) => {
  try {
    const { rows } = await db.query('SELECT * FROM deliveries WHERE id = $1 AND rider_id = $2', [
      req.params.id,
      req.user.id,
    ]);
    if (rows.length === 0) return res.status(404).json({ message: 'Delivery not found.' });

    const eta = predictEtaMinutes(rows[0].distance_km, new Date());

    const upd = await db.query(
      `UPDATE deliveries
       SET status = 'en_route', picked_up_at = NOW(), estimated_minutes = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [eta.estimatedMinutes, req.params.id]
    );

    await db.query("UPDATE orders SET status = 'en_route', updated_at = NOW() WHERE id = $1", [
      rows[0].order_id,
    ]);

    const ordRes = await db.query('SELECT customer_id, order_number FROM orders WHERE id = $1', [
      rows[0].order_id,
    ]);
    if (ordRes.rows.length > 0) {
      await createAndEmitNotification({
        userId: ordRes.rows[0].customer_id,
        title: 'Rider Is En Route',
        message: `Your order ${ordRes.rows[0].order_number} is on the way! Live ETA: ~${eta.estimatedMinutes} mins.`,
        category: 'delivery',
        metadata: { orderId: rows[0].order_id, estimatedMinutes: eta.estimatedMinutes },
      });
      emitToUser(ordRes.rows[0].customer_id, 'delivery:eta_updated', {
        orderId: rows[0].order_id,
        estimatedMinutes: eta.estimatedMinutes,
      });
    }

    return res.json({ delivery: upd.rows[0], eta });
  } catch (error) {
    return res.status(500).json({ message: 'Failed to update pickup status.' });
  }
});

/**
 * POST /api/delivery/:id/verify-pin
 * Verifies the 4-digit Proof of Delivery (PoD) PIN from the customer,
 * marks order/delivery complete, releases Escrow funds to Vendor & Rider,
 * and logs trip_analytics for Predictive AI ETA training.
 */
router.post('/:id/verify-pin', async (req, res) => {
  const client = await db.getClient();
  try {
    const { pin } = req.body;
    if (!pin || !/^\d{4}$/.test(String(pin))) {
      return res.status(400).json({ message: 'Please enter a valid 4-digit PIN.' });
    }

    const delivRes = await client.query('SELECT * FROM deliveries WHERE id = $1 AND rider_id = $2', [
      req.params.id,
      req.user.id,
    ]);
    if (delivRes.rows.length === 0) {
      return res.status(404).json({ message: 'Active delivery not found.' });
    }
    const delivery = delivRes.rows[0];

    const ordRes = await client.query(
      `SELECT o.*, b.owner_id AS vendor_user_id
       FROM orders o JOIN businesses b ON b.id = o.business_id
       WHERE o.id = $1`,
      [delivery.order_id]
    );
    const order = ordRes.rows[0];

    const pinValid = order.pod_pin_hash
      ? await bcrypt.compare(String(pin), order.pod_pin_hash)
      : order.pod_pin_plain === String(pin);

    if (!pinValid) {
      return res.status(400).json({ message: 'Incorrect 4-digit Proof of Delivery PIN.' });
    }

    await client.query('BEGIN');

    await client.query(
      `UPDATE deliveries SET status = 'delivered', delivered_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [delivery.id]
    );

    const newPaymentStatus = order.payment_status === 'escrow_held' ? 'released' : order.payment_status;
    await client.query(
      `UPDATE orders SET status = 'completed', payment_status = $1, updated_at = NOW() WHERE id = $2`,
      [newPaymentStatus, order.id]
    );

    // Release Escrow funds if held
    if (order.payment_status === 'escrow_held') {
      const vendorAmount = Number(order.subtotal);
      const riderAmount = Number(delivery.rider_fee || order.delivery_fee || 0);

      // Vendor wallet release
      const vWallet = await client.query(
        `UPDATE escrow_wallets
         SET held_balance = GREATEST(0, held_balance - $1),
             available_balance = available_balance + $1,
             total_earned = total_earned + $1,
             updated_at = NOW()
         WHERE user_id = $2
         RETURNING id`,
        [vendorAmount, order.vendor_user_id]
      );
      if (vWallet.rows.length > 0) {
        await client.query(
          `INSERT INTO escrow_transactions (order_id, wallet_id, tx_type, amount, description)
           VALUES ($1, $2, 'escrow_release', $3, $4)`,
          [order.id, vWallet.rows[0].id, vendorAmount, `Escrow released for order ${order.order_number}`]
        );
      }

      // Rider wallet payout
      if (riderAmount > 0) {
        await client.query(
          `INSERT INTO escrow_wallets (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`,
          [req.user.id]
        );
        const rWallet = await client.query(
          `UPDATE escrow_wallets
           SET available_balance = available_balance + $1,
               total_earned = total_earned + $1,
               updated_at = NOW()
           WHERE user_id = $2
           RETURNING id`,
          [riderAmount, req.user.id]
        );
        await client.query(
          `INSERT INTO escrow_transactions (order_id, wallet_id, tx_type, amount, description)
           VALUES ($1, $2, 'rider_payout', $3, $4)`,
          [order.id, rWallet.rows[0].id, riderAmount, `Delivery payout for order ${order.order_number}`]
        );
      }

      await client.query("UPDATE payments SET status = 'released', updated_at = NOW() WHERE order_id = $1", [
        order.id,
      ]);
    }

    // Record historical trip matrix for AI ETA regression
    const startTime = delivery.picked_up_at ? new Date(delivery.picked_up_at) : new Date(delivery.created_at);
    const actualMinutes = Math.max(5, Math.round((Date.now() - startTime.getTime()) / 60000));
    const now = new Date();
    await client.query(
      `INSERT INTO trip_analytics (delivery_id, distance_km, hour_of_day, day_of_week, actual_duration_minutes)
       VALUES ($1, $2, $3, $4, $5)`,
      [delivery.id, Number(delivery.distance_km) || 1, now.getHours(), now.getDay(), actualMinutes]
    );

    await client.query('COMMIT');

    await createAndEmitNotification({
      userId: order.customer_id,
      title: 'Order Delivered',
      message: `Order ${order.order_number} has been verified and completed.`,
      category: 'delivery',
    });
    await createAndEmitNotification({
      userId: order.vendor_user_id,
      title: 'Delivery Completed & Escrow Released',
      message: `Order ${order.order_number} was delivered. Funds have been released to your wallet.`,
      category: 'payment',
    });

    return res.json({
      message: 'Proof of Delivery PIN verified! Order completed and escrow funds released.',
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[Verify PoD PIN] Error:', error);
    return res.status(500).json({ message: 'Failed to verify PIN.' });
  } finally {
    client.release();
  }
});

module.exports = router;
