const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const { v4: uuidv4 } = require('uuid');
const db = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');
const { createAndEmitNotification, emitToRole } = require('../services/notificationService');
const { predictEtaMinutes } = require('../services/aiService');
const { haversineDistanceKm } = require('../utils/geo');
const { logAudit } = require('../utils/audit');

const router = express.Router();

router.use(authenticate);

function getEffectivePrice(item) {
  const hasActivePromo =
    item.promo_price != null &&
    (!item.promo_ends_at || new Date(item.promo_ends_at) > new Date());
  return hasActivePromo ? Number(item.promo_price) : Number(item.price);
}

/**
 * POST /api/orders/checkout
 * Automated split-order routing: groups cart items (or payload items) by vendor/business,
 * creates one order per vendor under a shared checkout_group_id, deducts inventory,
 * generates 4-digit PoD PIN, and creates delivery tasks with AI ETA.
 */
router.post('/checkout', authorize('customer'), async (req, res) => {
  const client = await db.getClient();
  try {
    const {
      fulfillmentType = 'delivery',
      deliveryAddress,
      deliveryLatitude,
      deliveryLongitude,
      notes,
      items: bodyItems,
    } = req.body;

    let cartRows = [];
    if (Array.isArray(bodyItems) && bodyItems.length > 0) {
      // Allow offline localStorage cart sync directly at checkout
      const productIds = bodyItems.map((i) => i.productId);
      const { rows } = await client.query(
        `SELECT p.*, b.id AS business_id, b.owner_id AS vendor_user_id, b.name AS business_name,
                b.address AS business_address, b.latitude AS business_lat, b.longitude AS business_lng
         FROM products_services p
         JOIN businesses b ON b.id = p.business_id
         WHERE p.id = ANY($1::uuid[]) AND b.approval_status = 'approved'`,
        [productIds]
      );
      const map = new Map(rows.map((r) => [r.id, r]));
      for (const bi of bodyItems) {
        const prod = map.get(bi.productId);
        if (prod) {
          cartRows.push({
            ...prod,
            product_id: prod.id,
            quantity: Number(bi.quantity) || 1,
            selected_combo: bi.selectedCombo || null,
          });
        }
      }
    } else {
      const { rows } = await client.query(
        `SELECT ci.quantity, ci.selected_combo, ci.product_id, ci.business_id,
                p.name, p.price, p.promo_price, p.promo_ends_at, p.item_type, p.stock_quantity, p.low_stock_threshold,
                b.owner_id AS vendor_user_id, b.name AS business_name,
                b.address AS business_address, b.latitude AS business_lat, b.longitude AS business_lng
         FROM cart_items ci
         JOIN products_services p ON p.id = ci.product_id
         JOIN businesses b ON b.id = ci.business_id
         WHERE ci.user_id = $1`,
        [req.user.id]
      );
      cartRows = rows;
    }

    if (cartRows.length === 0) {
      return res.status(400).json({ message: 'Your smart cart is empty.' });
    }

    // Group items by businessId (Split-Order Routing)
    const groups = new Map();
    for (const item of cartRows) {
      if (!groups.has(item.business_id)) {
        groups.set(item.business_id, []);
      }
      groups.get(item.business_id).push(item);
    }

    const checkoutGroupId = uuidv4();
    const createdOrders = [];

    await client.query('BEGIN');

    for (const [businessId, items] of groups.entries()) {
      let subtotal = 0;
      for (const it of items) {
        if (it.item_type === 'product' && it.stock_quantity < it.quantity) {
          throw new Error(`Insufficient stock for "${it.name}".`);
        }
        const unitPrice = getEffectivePrice(it);
        subtotal += unitPrice * it.quantity;
      }

      const firstItem = items[0];
      const distKm =
        haversineDistanceKm(
          firstItem.business_lat,
          firstItem.business_lng,
          deliveryLatitude ?? req.user.latitude,
          deliveryLongitude ?? req.user.longitude
        ) || 2.5;

      const deliveryFee = fulfillmentType === 'delivery' ? Math.max(1500, Math.round(distKm * 800)) : 0;
      const totalAmount = subtotal + deliveryFee;

      // Generate secure 4-digit Proof of Delivery (PoD) PIN
      const pinPlain = String(crypto.randomInt(1000, 10000));
      const pinHash = await bcrypt.hash(pinPlain, 10);
      const orderNumber = `JM-${Date.now().toString().slice(-6)}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;

      const orderRes = await client.query(
        `INSERT INTO orders (
          order_number, checkout_group_id, customer_id, business_id, fulfillment_type,
          delivery_address, delivery_latitude, delivery_longitude,
          subtotal, delivery_fee, total_amount, status, payment_status, pod_pin_hash, pod_pin_plain, notes
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'pending', 'unpaid', $12, $13, $14)
        RETURNING *`,
        [
          orderNumber,
          checkoutGroupId,
          req.user.id,
          businessId,
          fulfillmentType,
          deliveryAddress || req.user.location_label || 'Customer Location',
          deliveryLatitude ?? req.user.latitude ?? null,
          deliveryLongitude ?? req.user.longitude ?? null,
          subtotal,
          deliveryFee,
          totalAmount,
          pinHash,
          pinPlain,
          notes || null,
        ]
      );

      const order = orderRes.rows[0];

      for (const it of items) {
        const unitPrice = getEffectivePrice(it);
        await client.query(
          `INSERT INTO order_items (order_id, product_id, item_name, quantity, unit_price, line_total, selected_combo)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            order.id,
            it.product_id,
            it.name,
            it.quantity,
            unitPrice,
            unitPrice * it.quantity,
            it.selected_combo ? JSON.stringify(it.selected_combo) : null,
          ]
        );

        // Deduct inventory and record AI purchase behavior
        if (it.item_type === 'product') {
          const upd = await client.query(
            `UPDATE products_services
             SET stock_quantity = GREATEST(0, stock_quantity - $1),
                 is_available = CASE WHEN GREATEST(0, stock_quantity - $1) = 0 THEN FALSE ELSE is_available END,
                 updated_at = NOW()
             WHERE id = $2
             RETURNING stock_quantity, low_stock_threshold, name`,
            [it.quantity, it.product_id]
          );

          const updatedProd = upd.rows[0];
          if (updatedProd && updatedProd.stock_quantity <= updatedProd.low_stock_threshold) {
            await createAndEmitNotification({
              userId: firstItem.vendor_user_id,
              title: updatedProd.stock_quantity === 0 ? 'Out of Stock Alert' : 'Low Stock Alert',
              message: `${updatedProd.name} has ${updatedProd.stock_quantity} remaining.`,
              category: 'inventory',
            });
          }
        }

        await client.query(
          `INSERT INTO user_behaviors (user_id, product_id, business_id, action_type, weight)
           VALUES ($1, $2, $3, 'purchase', 5)`,
          [req.user.id, it.product_id, businessId]
        );
      }

      // Create Delivery dispatch record if delivery
      if (fulfillmentType === 'delivery') {
        const eta = predictEtaMinutes(distKm, new Date());
        await client.query(
          `INSERT INTO deliveries (
            order_id, pickup_address, pickup_latitude, pickup_longitude,
            dropoff_address, dropoff_latitude, dropoff_longitude,
            distance_km, rider_fee, estimated_minutes, status
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'awaiting_rider')`,
          [
            order.id,
            firstItem.business_address || firstItem.business_name,
            firstItem.business_lat,
            firstItem.business_lng,
            deliveryAddress || req.user.location_label || 'Customer Location',
            deliveryLatitude ?? req.user.latitude ?? null,
            deliveryLongitude ?? req.user.longitude ?? null,
            distKm,
            deliveryFee,
            eta.estimatedMinutes,
          ]
        );
      }

      createdOrders.push({
        ...order,
        businessName: firstItem.business_name,
        vendorUserId: firstItem.vendor_user_id,
      });
    }

    // Clear persistent cart
    await client.query('DELETE FROM cart_items WHERE user_id = $1', [req.user.id]);
    await client.query('COMMIT');

    // Notify vendors and broadcast to riders
    for (const ord of createdOrders) {
      await logAudit({
        actorId: req.user.id,
        actorEmail: req.user.email,
        action: 'ORDER_CREATED',
        targetType: 'order',
        targetId: ord.id,
        details: { orderNumber: ord.order_number, totalAmount: ord.total_amount },
      });
      await createAndEmitNotification({
        userId: ord.vendorUserId,
        title: 'New Order Received',
        message: `Order ${ord.order_number} (${ord.total_amount} TZS) was placed at ${ord.businessName}.`,
        category: 'order',
        metadata: { orderId: ord.id },
      });
    }

    if (fulfillmentType === 'delivery') {
      emitToRole('rider', 'delivery:available_updated', { checkoutGroupId });
    }

    return res.status(201).json({
      message: `Checkout complete. Created ${createdOrders.length} split order(s).`,
      checkoutGroupId,
      orders: createdOrders,
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[Checkout] Error:', error);
    return res.status(400).json({ message: error.message || 'Checkout failed.' });
  } finally {
    client.release();
  }
});

/**
 * GET /api/orders/customer (Customer's orders + PoD PIN + live delivery ETA)
 */
router.get('/customer', authorize('customer'), async (req, res) => {
  const { rows } = await db.query(
    `SELECT o.*, b.name AS business_name, b.phone AS business_phone,
            d.status AS delivery_status, d.estimated_minutes, d.distance_km,
            r.full_name AS rider_name, r.phone AS rider_phone,
            COALESCE(
              json_agg(json_build_object(
                'id', oi.id, 'itemName', oi.item_name, 'quantity', oi.quantity,
                'unitPrice', oi.unit_price, 'lineTotal', oi.line_total
              )) FILTER (WHERE oi.id IS NOT NULL), '[]'
            ) AS items
     FROM orders o
     JOIN businesses b ON b.id = o.business_id
     LEFT JOIN deliveries d ON d.order_id = o.id
     LEFT JOIN users r ON r.id = d.rider_id
     LEFT JOIN order_items oi ON oi.order_id = o.id
     WHERE o.customer_id = $1
     GROUP BY o.id, b.name, b.phone, d.status, d.estimated_minutes, d.distance_km, r.full_name, r.phone
     ORDER BY o.created_at DESC`,
    [req.user.id]
  );
  return res.json({ orders: rows });
});

/**
 * GET /api/orders/vendor (Vendor's incoming orders)
 */
router.get('/vendor', authorize('vendor'), async (req, res) => {
  const bizRes = await db.query('SELECT id FROM businesses WHERE owner_id = $1', [req.user.id]);
  if (bizRes.rows.length === 0) return res.status(404).json({ message: 'Business not found.' });

  const { rows } = await db.query(
    `SELECT o.id, o.order_number, o.status, o.payment_status, o.fulfillment_type,
            o.subtotal, o.delivery_fee, o.total_amount, o.delivery_address, o.notes, o.created_at,
            u.full_name AS customer_name, u.phone AS customer_phone,
            d.status AS delivery_status, d.estimated_minutes, r.full_name AS rider_name,
            COALESCE(
              json_agg(json_build_object(
                'id', oi.id, 'itemName', oi.item_name, 'quantity', oi.quantity,
                'unitPrice', oi.unit_price, 'lineTotal', oi.line_total
              )) FILTER (WHERE oi.id IS NOT NULL), '[]'
            ) AS items
     FROM orders o
     JOIN users u ON u.id = o.customer_id
     LEFT JOIN deliveries d ON d.order_id = o.id
     LEFT JOIN users r ON r.id = d.rider_id
     LEFT JOIN order_items oi ON oi.order_id = o.id
     WHERE o.business_id = $1
     GROUP BY o.id, u.full_name, u.phone, d.status, d.estimated_minutes, r.full_name
     ORDER BY o.created_at DESC`,
    [bizRes.rows[0].id]
  );
  return res.json({ orders: rows });
});

/**
 * PUT /api/orders/:id/status (Vendor updates order status)
 */
router.put('/:id/status', authorize('vendor'), async (req, res) => {
  try {
    const { status } = req.body;
    const allowed = ['accepted', 'preparing', 'ready_for_pickup', 'cancelled'];
    if (!allowed.includes(status)) {
      return res.status(400).json({ message: 'Invalid order status transition.' });
    }

    const bizRes = await db.query('SELECT id, name FROM businesses WHERE owner_id = $1', [req.user.id]);
    if (bizRes.rows.length === 0) return res.status(404).json({ message: 'Business not found.' });

    const { rows } = await db.query(
      `UPDATE orders SET status = $1, updated_at = NOW()
       WHERE id = $2 AND business_id = $3
       RETURNING *`,
      [status, req.params.id, bizRes.rows[0].id]
    );
    if (rows.length === 0) return res.status(404).json({ message: 'Order not found.' });

    const order = rows[0];
    const friendly = {
      accepted: 'Order Accepted',
      preparing: 'Order Is Being Prepared',
      ready_for_pickup: 'Order Ready for Pickup',
      cancelled: 'Order Cancelled',
    };

    await createAndEmitNotification({
      userId: order.customer_id,
      title: friendly[status],
      message: `${bizRes.rows[0].name} updated order ${order.order_number} to "${status.replace(/_/g, ' ')}".`,
      category: 'order',
      metadata: { orderId: order.id, status },
    });

    if (status === 'ready_for_pickup') {
      emitToRole('rider', 'delivery:available_updated', { orderId: order.id });
    }

    return res.json({ order, message: 'Order status updated.' });
  } catch (error) {
    console.error('[Order Status] Error:', error);
    return res.status(500).json({ message: 'Failed to update order status.' });
  }
});

module.exports = router;

