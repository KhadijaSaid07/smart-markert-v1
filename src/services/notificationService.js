const db = require('../config/db');

let ioInstance = null;

function setSocketIO(io) {
  ioInstance = io;
}

function getSocketIO() {
  return ioInstance;
}

/**
 * Persist a notification in PostgreSQL and push it in real time via Socket.io.
 */
async function createAndEmitNotification({
  userId,
  title,
  message,
  category = 'system',
  metadata = {},
}) {
  try {
    const { rows } = await db.query(
      `INSERT INTO notifications (user_id, title, message, category, metadata)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [userId, title, message, category, JSON.stringify(metadata)]
    );

    const notification = rows[0];
    if (ioInstance) {
      ioInstance.to(`user:${userId}`).emit('notification:new', notification);
    }
    return notification;
  } catch (err) {
    console.error('[NotificationService] Error:', err.message);
    return null;
  }
}

function emitToUser(userId, event, payload) {
  if (ioInstance && userId) {
    ioInstance.to(`user:${userId}`).emit(event, payload);
  }
}

function emitToRole(role, event, payload) {
  if (ioInstance && role) {
    ioInstance.to(`role:${role}`).emit(event, payload);
  }
}

module.exports = {
  setSocketIO,
  getSocketIO,
  createAndEmitNotification,
  emitToUser,
  emitToRole,
};

