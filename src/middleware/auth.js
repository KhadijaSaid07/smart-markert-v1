const jwt = require('jsonwebtoken');
const env = require('../config/env');
const db = require('../config/db');

/**
 * Verifies JWT token and loads fresh user status from PostgreSQL.
 */
async function authenticate(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ message: 'Authentication required. Please log in.' });
    }

    const token = authHeader.slice(7).trim();
    const decoded = jwt.verify(token, env.jwt.secret);

    const { rows } = await db.query(
      `SELECT id, full_name, email, phone, role, approval_status, is_active,
              location_label, latitude, longitude, vehicle_type, is_online, preferred_language, avatar_url
       FROM users WHERE id = $1`,
      [decoded.userId]
    );

    if (rows.length === 0) {
      return res.status(401).json({ message: 'User account no longer exists.' });
    }

    const user = rows[0];

    if (!user.is_active) {
      return res.status(403).json({ message: 'Your account has been deactivated. Contact support.' });
    }

    // Vendors and Delivery Riders MUST be approved by Admin before accessing any protected service
    if ((user.role === 'vendor' || user.role === 'rider') && user.approval_status !== 'approved') {
      return res.status(403).json({
        code: 'APPROVAL_REQUIRED',
        approvalStatus: user.approval_status,
        message:
          user.approval_status === 'pending'
            ? 'Your account is awaiting administrator approval before you can access services.'
            : `Your account status is "${user.approval_status}". Please contact an administrator.`,
      });
    }

    req.user = user;
    next();
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({ message: 'Session expired. Please log in again.' });
    }
    return res.status(401).json({ message: 'Invalid authentication token.' });
  }
}

/**
 * Optional auth for public discovery routes (e.g., to personalize AI recommendations if logged in).
 */
async function optionalAuthenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return next();
  }
  try {
    const token = authHeader.slice(7).trim();
    const decoded = jwt.verify(token, env.jwt.secret);
    const { rows } = await db.query(
      'SELECT id, email, role, approval_status, is_active, latitude, longitude FROM users WHERE id = $1',
      [decoded.userId]
    );
    if (rows.length > 0 && rows[0].is_active) {
      req.user = rows[0];
    }
  } catch {
    // Ignore invalid optional token
  }
  next();
}

/**
 * Role-based access control middleware.
 */
function authorize(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ message: 'Authentication required.' });
    }
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ message: 'Access denied for your account role.' });
    }
    next();
  };
}

module.exports = {
  authenticate,
  optionalAuthenticate,
  authorize,
};

