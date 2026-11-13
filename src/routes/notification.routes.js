const express = require('express');
const db = require('../config/db');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

router.use(authenticate);

router.get('/', async (req, res) => {
  const { rows } = await db.query(
    'SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 60',
    [req.user.id]
  );
  return res.json({ notifications: rows });
});

router.put('/read-all', async (req, res) => {
  await db.query('UPDATE notifications SET is_read = TRUE WHERE user_id = $1', [req.user.id]);
  return res.json({ message: 'All notifications marked as read.' });
});

router.put('/:id/read', async (req, res) => {
  await db.query('UPDATE notifications SET is_read = TRUE WHERE id = $1 AND user_id = $2', [
    req.params.id,
    req.user.id,
  ]);
  return res.json({ message: 'Notification marked as read.' });
});

module.exports = router;

