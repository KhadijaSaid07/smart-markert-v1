const db = require('../config/db');

async function logAudit({ actorId = null, actorEmail = null, action, targetType = null, targetId = null, details = {} }) {
  try {
    await db.query(
      `INSERT INTO audit_logs (actor_id, actor_email, action, target_type, target_id, details)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [actorId, actorEmail, action, targetType, targetId ? String(targetId) : null, JSON.stringify(details)]
    );
  } catch (err) {
    console.error('[AuditLog] Failed to write audit log:', err.message);
  }
}

module.exports = { logAudit };
