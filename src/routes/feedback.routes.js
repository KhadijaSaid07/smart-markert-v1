const express = require('express');
const db = require('../config/db');
const { authenticate, authorize } = require('../middleware/auth');
const { createAndEmitNotification } = require('../services/notificationService');

const router = express.Router();

/**
 * POST /api/feedback
 * Any authenticated user (customer, vendor, rider) can submit platform feedback.
 */
router.post('/', authenticate, async (req, res) => {
  try {
    const { category = 'general', rating, subject, message } = req.body;
    if (!subject || !message) {
      return res.status(400).json({ message: 'Subject and message are required.' });
    }

    const { rows } = await db.query(
      `INSERT INTO feedback (user_id, user_role, category, rating, subject, message)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        req.user.id,
        req.user.role,
        category,
        rating ? Number(rating) : null,
        subject.trim(),
        message.trim(),
      ]
    );

    // Notify admins
    const admins = await db.query("SELECT id FROM users WHERE role = 'admin' AND is_active = TRUE");
    for (const admin of admins.rows) {
      await createAndEmitNotification({
        userId: admin.id,
        title: 'New User Feedback',
        message: `${req.user.full_name} (${req.user.role}) submitted feedback: ${subject.trim()}`,
        category: 'feedback',
      });
    }

    return res.status(201).json({ feedback: rows[0], message: 'Thank you for your feedback!' });
  } catch (error) {
    console.error('[Feedback Create] Error:', error);
    return res.status(500).json({ message: 'Failed to submit feedback.' });
  }
});

/**
 * GET /api/feedback/my
 */
router.get('/my', authenticate, async (req, res) => {
  const { rows } = await db.query(
    'SELECT * FROM feedback WHERE user_id = $1 ORDER BY created_at DESC',
    [req.user.id]
  );
  return res.json({ feedback: rows });
});

/**
 * GET /api/feedback (Admin only)
 */
router.get('/', authenticate, authorize('admin'), async (req, res) => {
  const { rows } = await db.query(
    `SELECT f.*, u.full_name, u.email
     FROM feedback f
     LEFT JOIN users u ON u.id = f.user_id
     ORDER BY f.created_at DESC`
  );
  return res.json({ feedback: rows });
});

/**
 * PUT /api/feedback/:id (Admin responds / resolves feedback)
 */
router.put('/:id', authenticate, authorize('admin'), async (req, res) => {
  const { status, adminResponse } = req.body;
  const { rows } = await db.query(
    `UPDATE feedback SET
      status = COALESCE($1, status),
      admin_response = COALESCE($2, admin_response),
      updated_at = NOW()
     WHERE id = $3
     RETURNING *`,
    [status || null, adminResponse || null, req.params.id]
  );
  if (rows.length === 0) return res.status(404).json({ message: 'Feedback not found.' });

  if (rows[0].user_id) {
    await createAndEmitNotification({
      userId: rows[0].user_id,
      title: 'Feedback Update',
      message: `Admin responded to your feedback "${rows[0].subject}".`,
      category: 'feedback',
    });
  }

  return res.json({ feedback: rows[0] });
});

module.exports = router;

