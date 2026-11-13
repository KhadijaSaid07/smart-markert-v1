const express = require('express');
const bcrypt = require('bcrypt');
const db = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');
const { createAndEmitNotification } = require('../services/notificationService');
const { runBackup, listBackups } = require('../services/backupService');
const { triggerOffPeakTraining } = require('../services/aiService');
const { logAudit } = require('../utils/audit');

const router = express.Router();

router.use(authenticate, authorize('admin'));

/**
 * GET /api/admin/overview
 * Platform-wide GTV, active/inactive users, pending approvals, orders, deliveries, feedback.
 */
router.get('/overview', async (req, res) => {
  try {
    const [usersRes, bizRes, prodRes, ordersRes, gtvRes, delivRes, pendingRes, fbRes] = await Promise.all([
      db.query('SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE is_active) ::int AS active FROM users'),
      db.query("SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE approval_status = 'approved')::int AS approved FROM businesses"),
      db.query('SELECT COUNT(*)::int AS total FROM products_services'),
      db.query('SELECT COUNT(*)::int AS total FROM orders'),
      db.query("SELECT COALESCE(SUM(total_amount), 0)::numeric AS gtv FROM orders WHERE payment_status IN ('escrow_held', 'released')"),
      db.query('SELECT COUNT(*)::int AS total FROM deliveries'),
      db.query("SELECT COUNT(*)::int AS pending FROM users WHERE role IN ('vendor', 'rider') AND approval_status = 'pending'"),
      db.query("SELECT COUNT(*)::int AS open_feedback FROM feedback WHERE status = 'open'"),
    ]);

    return res.json({
      totalUsers: usersRes.rows[0].total,
      activeUsers: usersRes.rows[0].active,
      totalBusinesses: bizRes.rows[0].total,
      approvedBusinesses: bizRes.rows[0].approved,
      totalProducts: prodRes.rows[0].total,
      totalOrders: ordersRes.rows[0].total,
      grossTransactionVolume: Number(gtvRes.rows[0].gtv),
      totalDeliveries: delivRes.rows[0].total,
      pendingApprovals: pendingRes.rows[0].pending,
      openFeedback: fbRes.rows[0].open_feedback,
      systemMetrics: {
        uptimeSeconds: Math.round(process.uptime()),
        memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
        nodeVersion: process.version,
      },
    });
  } catch (error) {
    console.error('[Admin Overview] Error:', error);
    return res.status(500).json({ message: 'Failed to load admin overview.' });
  }
});

/**
 * GET /api/admin/users
 */
router.get('/users', async (req, res) => {
  try {
    const { role, status, search } = req.query;
    const conditions = [];
    const params = [];

    if (role && role !== 'all') {
      params.push(role);
      conditions.push(`u.role = $${params.length}`);
    }
    if (status && status !== 'all') {
      params.push(status);
      conditions.push(`u.approval_status = $${params.length}`);
    }
    if (search) {
      params.push(`%${search.trim().toLowerCase()}%`);
      conditions.push(`(LOWER(u.full_name) LIKE $${params.length} OR LOWER(u.email) LIKE $${params.length})`);
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const { rows } = await db.query(
      `SELECT u.id, u.full_name, u.email, u.phone, u.role, u.approval_status, u.is_active,
              u.location_label, u.vehicle_type, u.created_at,
              b.id AS business_id, b.name AS business_name, b.category AS business_category
       FROM users u
       LEFT JOIN businesses b ON b.owner_id = u.id
       ${whereClause}
       ORDER BY u.created_at DESC`,
      params
    );
    return res.json({ users: rows });
  } catch (error) {
    console.error('[Admin Users] Error:', error);
    return res.status(500).json({ message: 'Failed to fetch users.' });
  }
});

/**
 * PUT /api/admin/users/:id/approval
 * Approve, reject, or suspend a vendor, rider, or user account.
 */
router.put('/users/:id/approval', async (req, res) => {
  try {
    const { id } = req.params;
    const { approvalStatus } = req.body;

    if (!['approved', 'rejected', 'suspended', 'pending'].includes(approvalStatus)) {
      return res.status(400).json({ message: 'Invalid approval status.' });
    }

    const { rows } = await db.query(
      `UPDATE users SET approval_status = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
      [approvalStatus, id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ message: 'User not found.' });
    }

    const target = rows[0];
    if (target.role === 'vendor') {
      await db.query(
        'UPDATE businesses SET approval_status = $1, updated_at = NOW() WHERE owner_id = $2',
        [approvalStatus, target.id]
      );
    }

    await createAndEmitNotification({
      userId: target.id,
      title: `Account ${approvalStatus}`,
      message:
        approvalStatus === 'approved'
          ? 'Your JamiiMarket account has been approved by an administrator! You can now log in and use all services.'
          : `Your JamiiMarket account status was updated to "${approvalStatus}".`,
      category: 'approval',
    });

    await logAudit({
      actorId: req.user.id,
      actorEmail: req.user.email,
      action: `USER_${approvalStatus.toUpperCase()}`,
      targetType: 'user',
      targetId: target.id,
      details: { email: target.email, role: target.role },
    });

    return res.json({ message: `User ${approvalStatus} successfully.`, user: target });
  } catch (error) {
    console.error('[Admin Approval] Error:', error);
    return res.status(500).json({ message: 'Failed to update approval status.' });
  }
});

/**
 * POST /api/admin/admins
 * Create an additional administrator account.
 */
router.post('/admins', async (req, res) => {
  try {
    const { fullName, email, password, phone } = req.body;
    if (!fullName || !email || !password || password.length < 6) {
      return res.status(400).json({ message: 'Full name, email, and 6+ char password are required.' });
    }

    const hash = await bcrypt.hash(password, 12);
    const { rows } = await db.query(
      `INSERT INTO users (full_name, email, phone, password_hash, role, approval_status, is_active)
       VALUES ($1, $2, $3, $4, 'admin', 'approved', TRUE)
       RETURNING id, full_name, email, role, created_at`,
      [fullName.trim(), email.trim().toLowerCase(), phone?.trim() || null, hash]
    );

    await logAudit({
      actorId: req.user.id,
      actorEmail: req.user.email,
      action: 'ADMIN_CREATED',
      targetType: 'user',
      targetId: rows[0].id,
      details: { email: rows[0].email },
    });

    return res.status(201).json({ admin: rows[0] });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ message: 'Email already exists.' });
    }
    return res.status(500).json({ message: 'Failed to create admin.' });
  }
});

/**
 * GET /api/admin/businesses, /products, /orders, /deliveries, /payments, /audit-logs
 */
router.get('/businesses', async (req, res) => {
  const { rows } = await db.query(
    `SELECT b.*, u.full_name AS owner_name, u.email AS owner_email
     FROM businesses b JOIN users u ON u.id = b.owner_id
     ORDER BY b.created_at DESC`
  );
  res.json({ businesses: rows });
});

router.get('/products', async (req, res) => {
  const { rows } = await db.query(
    `SELECT p.*, b.name AS business_name
     FROM products_services p JOIN businesses b ON b.id = p.business_id
     ORDER BY p.created_at DESC LIMIT 200`
  );
  res.json({ products: rows });
});

router.get('/orders', async (req, res) => {
  const { rows } = await db.query(
    `SELECT o.*, b.name AS business_name, u.full_name AS customer_name, u.email AS customer_email
     FROM orders o
     JOIN businesses b ON b.id = o.business_id
     JOIN users u ON u.id = o.customer_id
     ORDER BY o.created_at DESC LIMIT 200`
  );
  res.json({ orders: rows });
});

router.get('/deliveries', async (req, res) => {
  const { rows } = await db.query(
    `SELECT d.*, o.order_number, b.name AS business_name, r.full_name AS rider_name
     FROM deliveries d
     JOIN orders o ON o.id = d.order_id
     JOIN businesses b ON b.id = o.business_id
     LEFT JOIN users r ON r.id = d.rider_id
     ORDER BY d.created_at DESC LIMIT 200`
  );
  res.json({ deliveries: rows });
});

router.get('/payments', async (req, res) => {
  const { rows } = await db.query(
    `SELECT p.*, u.full_name AS customer_name, o.order_number
     FROM payments p
     JOIN users u ON u.id = p.customer_id
     LEFT JOIN orders o ON o.id = p.order_id
     ORDER BY p.created_at DESC LIMIT 200`
  );
  res.json({ payments: rows });
});

router.get('/audit-logs', async (req, res) => {
  const { rows } = await db.query('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 200');
  res.json({ logs: rows });
});

/**
 * Backups & AI Training Management
 */
router.get('/backups', (req, res) => {
  res.json({ backups: listBackups() });
});

router.post('/backups', async (req, res) => {
  try {
    const manifest = await runBackup('admin-manual');
    await logAudit({
      actorId: req.user.id,
      actorEmail: req.user.email,
      action: 'BACKUP_CREATED',
      details: manifest,
    });
    res.status(201).json({ message: 'Backup completed.', backup: manifest });
  } catch (error) {
    res.status(500).json({ message: 'Backup failed: ' + error.message });
  }
});

router.post('/ai/train', async (req, res) => {
  const result = await triggerOffPeakTraining();
  res.json({ message: 'AI training triggered.', result });
});

module.exports = router;
