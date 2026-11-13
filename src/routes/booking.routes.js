const express = require('express');
const crypto = require('crypto');
const db = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');
const { createAndEmitNotification } = require('../services/notificationService');

const router = express.Router();

const DEFAULT_SLOTS = [
  '09:00 - 10:00',
  '10:00 - 11:00',
  '11:00 - 12:00',
  '12:00 - 13:00',
  '14:00 - 15:00',
  '15:00 - 16:00',
  '16:00 - 17:00',
];

/**
 * GET /api/bookings/slots/:businessId?date=YYYY-MM-DD
 */
router.get('/slots/:businessId', async (req, res) => {
  try {
    const { businessId } = req.params;
    const date = req.query.date || new Date().toISOString().slice(0, 10);

    const { rows } = await db.query(
      `SELECT time_slot FROM service_bookings
       WHERE business_id = $1 AND booking_date = $2 AND status IN ('pending', 'confirmed')`,
      [businessId, date]
    );
    const taken = new Set(rows.map((r) => r.time_slot));

    const slots = DEFAULT_SLOTS.map((slot) => ({
      slot,
      available: !taken.has(slot),
    }));

    return res.json({ date, slots });
  } catch (error) {
    console.error('[Booking Slots] Error:', error);
    return res.status(500).json({ message: 'Failed to load available time slots.' });
  }
});

/**
 * POST /api/bookings (Customer books a service time slot)
 */
router.post('/', authenticate, authorize('customer'), async (req, res) => {
  try {
    const { serviceId, bookingDate, timeSlot, durationHours = 1, notes } = req.body;
    if (!serviceId || !bookingDate || !timeSlot) {
      return res.status(400).json({ message: 'serviceId, bookingDate, and timeSlot are required.' });
    }

    const svcRes = await db.query(
      `SELECT p.*, b.owner_id AS vendor_user_id, b.name AS business_name
       FROM products_services p
       JOIN businesses b ON b.id = p.business_id
       WHERE p.id = $1 AND p.item_type = 'service' AND b.approval_status = 'approved'`,
      [serviceId]
    );
    if (svcRes.rows.length === 0) {
      return res.status(404).json({ message: 'Service not found.' });
    }
    const svc = svcRes.rows[0];

    const conflict = await db.query(
      `SELECT id FROM service_bookings
       WHERE business_id = $1 AND booking_date = $2 AND time_slot = $3 AND status IN ('pending', 'confirmed')`,
      [svc.business_id, bookingDate, timeSlot]
    );
    if (conflict.rows.length > 0) {
      return res.status(409).json({ message: 'This time slot is already booked.' });
    }

    const effectivePrice =
      svc.promo_price != null && (!svc.promo_ends_at || new Date(svc.promo_ends_at) > new Date())
        ? Number(svc.promo_price)
        : Number(svc.price);

    const duration = Math.max(0.5, Number(durationHours) || 1);
    const totalAmount = svc.billing_type === 'hourly' ? effectivePrice * duration : effectivePrice;
    const bookingNumber = `BK-${Date.now().toString().slice(-6)}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;

    const { rows } = await db.query(
      `INSERT INTO service_bookings (
        booking_number, customer_id, business_id, service_id, booking_date, time_slot, duration_hours, total_amount, notes
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *`,
      [
        bookingNumber,
        req.user.id,
        svc.business_id,
        svc.id,
        bookingDate,
        timeSlot,
        duration,
        totalAmount,
        notes || null,
      ]
    );

    await createAndEmitNotification({
      userId: svc.vendor_user_id,
      title: 'New Service Booking',
      message: `${req.user.full_name} booked ${svc.name} on ${bookingDate} (${timeSlot}).`,
      category: 'booking',
      metadata: { bookingId: rows[0].id },
    });

    return res.status(201).json({ booking: rows[0], message: 'Service booked successfully.' });
  } catch (error) {
    console.error('[Create Booking] Error:', error);
    return res.status(500).json({ message: 'Failed to create booking.' });
  }
});

/**
 * GET /api/bookings/my (Customer or Vendor bookings)
 */
router.get('/my', authenticate, async (req, res) => {
  try {
    if (req.user.role === 'vendor') {
      const bizRes = await db.query('SELECT id FROM businesses WHERE owner_id = $1', [req.user.id]);
      if (bizRes.rows.length === 0) return res.json({ bookings: [] });

      const { rows } = await db.query(
        `SELECT sb.*, p.name AS service_name, u.full_name AS customer_name, u.phone AS customer_phone
         FROM service_bookings sb
         JOIN products_services p ON p.id = sb.service_id
         JOIN users u ON u.id = sb.customer_id
         WHERE sb.business_id = $1
         ORDER BY sb.booking_date DESC, sb.time_slot ASC`,
        [bizRes.rows[0].id]
      );
      return res.json({ bookings: rows });
    }

    const { rows } = await db.query(
      `SELECT sb.*, p.name AS service_name, b.name AS business_name, b.address AS business_address
       FROM service_bookings sb
       JOIN products_services p ON p.id = sb.service_id
       JOIN businesses b ON b.id = sb.business_id
       WHERE sb.customer_id = $1
       ORDER BY sb.booking_date DESC, sb.time_slot ASC`,
      [req.user.id]
    );
    return res.json({ bookings: rows });
  } catch (error) {
    return res.status(500).json({ message: 'Failed to load bookings.' });
  }
});

/**
 * PUT /api/bookings/:id/status
 */
router.put('/:id/status', authenticate, async (req, res) => {
  const { status } = req.body;
  if (!['confirmed', 'completed', 'cancelled'].includes(status)) {
    return res.status(400).json({ message: 'Invalid booking status.' });
  }

  const { rows } = await db.query(
    'UPDATE service_bookings SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
    [status, req.params.id]
  );
  if (rows.length === 0) return res.status(404).json({ message: 'Booking not found.' });

  await createAndEmitNotification({
    userId: rows[0].customer_id,
    title: `Booking ${status}`,
    message: `Your booking ${rows[0].booking_number} is now ${status}.`,
    category: 'booking',
  });

  return res.json({ booking: rows[0] });
});

module.exports = router;

