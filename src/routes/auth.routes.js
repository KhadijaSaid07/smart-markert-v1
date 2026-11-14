const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const db = require('../config/db');
const env = require('../config/env');
const { authenticate } = require('../middleware/auth');
const { upload } = require('../middleware/upload');
const { createAndEmitNotification } = require('../services/notificationService');
const { logAudit } = require('../utils/audit');

const router = express.Router();

function signToken(user) {
  return jwt.sign(
    { userId: user.id, role: user.role, email: user.email },
    env.jwt.secret,
    { expiresIn: env.jwt.expiresIn }
  );
}

function sanitizeUser(row) {
  return {
    id: row.id,
    fullName: row.full_name,
    email: row.email,
    phone: row.phone,
    role: row.role,
    approvalStatus: row.approval_status,
    isActive: row.is_active,
    locationLabel: row.location_label,
    latitude: row.latitude,
    longitude: row.longitude,
    vehicleType: row.vehicle_type,
    isOnline: row.is_online,
    preferredLanguage: row.preferred_language,
    avatarUrl: row.avatar_url,
    createdAt: row.created_at,
  };
}

/**
 * POST /api/auth/register
 * Email + Password registration (no OTP).
 * Customers are approved immediately; Vendors and Riders require Admin approval.
 */
router.post('/register', async (req, res) => {
  const client = await db.getClient();
  try {
    const {
      fullName,
      email,
      password,
      phone,
      role = 'customer',
      businessName,
      businessCategory,
      locationLabel,
      latitude,
      longitude,
      vehicleType,
    } = req.body;

    if (!fullName || !email || !password) {
      return res.status(400).json({ message: 'Full name, email, and password are required.' });
    }

    if (password.length < 6) {
      return res.status(400).json({ message: 'Password must be at least 6 characters.' });
    }

    const normalizedRole = ['customer', 'vendor', 'rider'].includes(role) ? role : 'customer';
    const normalizedEmail = email.trim().toLowerCase();

    const existing = await client.query('SELECT id FROM users WHERE LOWER(email) = $1', [normalizedEmail]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ message: 'An account with this email already exists.' });
    }

    if (normalizedRole === 'vendor' && (!businessName || !businessName.trim())) {
      return res.status(400).json({ message: 'Business name is required for business accounts.' });
    }

    const approvalStatus = normalizedRole === 'customer' ? 'approved' : 'pending';
    const passwordHash = await bcrypt.hash(password, 12);

    await client.query('BEGIN');

    const userRes = await client.query(
      `INSERT INTO users (
        full_name, email, phone, password_hash, role, approval_status,
        location_label, latitude, longitude, vehicle_type
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING *`,
      [
        fullName.trim(),
        normalizedEmail,
        phone?.trim() || null,
        passwordHash,
        normalizedRole,
        approvalStatus,
        locationLabel?.trim() || null,
        latitude != null ? Number(latitude) : null,
        longitude != null ? Number(longitude) : null,
        vehicleType?.trim() || null,
      ]
    );

    const newUser = userRes.rows[0];

    await client.query(
      'INSERT INTO escrow_wallets (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING',
      [newUser.id]
    );

    let business = null;
    if (normalizedRole === 'vendor') {
      const bizRes = await client.query(
        `INSERT INTO businesses (
          owner_id, name, category, phone, email, address, latitude, longitude, approval_status
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending')
        RETURNING *`,
        [
          newUser.id,
          businessName.trim(),
          businessCategory?.trim() || 'Other',
          phone?.trim() || null,
          normalizedEmail,
          locationLabel?.trim() || null,
          latitude != null ? Number(latitude) : null,
          longitude != null ? Number(longitude) : null,
        ]
      );
      business = bizRes.rows[0];
    }

    await client.query('COMMIT');

    // Notify Admins if vendor or rider needs approval
    if (approvalStatus === 'pending') {
      const admins = await db.query("SELECT id FROM users WHERE role = 'admin' AND is_active = TRUE");
      for (const admin of admins.rows) {
        await createAndEmitNotification({
          userId: admin.id,
          title: 'New Approval Request',
          message: `${newUser.full_name} (${normalizedRole}) registered and is awaiting approval.`,
          category: 'approval',
          metadata: { targetUserId: newUser.id, role: normalizedRole },
        });
      }
    }

    await logAudit({
      actorId: newUser.id,
      actorEmail: newUser.email,
      action: 'USER_REGISTERED',
      targetType: 'user',
      targetId: newUser.id,
      details: { role: normalizedRole, approvalStatus },
    });

    const token = approvalStatus === 'approved' ? signToken(newUser) : null;

    return res.status(201).json({
      message:
        approvalStatus === 'approved'
          ? 'Account created successfully.'
          : 'Registration submitted. Your account is pending administrator approval before you can access services.',
      requiresApproval: approvalStatus === 'pending',
      token,
      user: sanitizeUser(newUser),
      business,
    });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[Auth Register] Error:', error);
    return res.status(500).json({ message: 'Failed to register account.' });
  } finally {
    client.release();
  }
});

/**
 * POST /api/auth/login
 * Email + Password login. Enforces admin approval for vendors and riders.
 */
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ message: 'Email and password are required.' });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const { rows } = await db.query('SELECT * FROM users WHERE LOWER(email) = $1', [normalizedEmail]);

    if (rows.length === 0) {
      await logAudit({
        actorEmail: normalizedEmail,
        action: 'USER_LOGIN_FAILED',
        targetType: 'login',
        details: { reason: 'account_not_found' },
      });
      return res.status(401).json({ message: 'Invalid email or password.' });
    }

    const user = rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      await logAudit({
        actorId: user.id,
        actorEmail: user.email,
        action: 'USER_LOGIN_FAILED',
        targetType: 'login',
        targetId: user.id,
        details: { reason: 'invalid_password' },
      });
      return res.status(401).json({ message: 'Invalid email or password.' });
    }

    if (!user.is_active) {
      return res.status(403).json({ message: 'Your account has been deactivated.' });
    }

    if ((user.role === 'vendor' || user.role === 'rider') && user.approval_status !== 'approved') {
      return res.status(403).json({
        code: 'APPROVAL_REQUIRED',
        approvalStatus: user.approval_status,
        message:
          user.approval_status === 'pending'
            ? 'Your account is still awaiting administrator approval.'
            : `Your account is ${user.approval_status}. Please contact an administrator.`,
      });
    }

    const token = signToken(user);

    await logAudit({
      actorId: user.id,
      actorEmail: user.email,
      action: 'USER_LOGIN_SUCCESS',
      targetType: 'login',
      targetId: user.id,
      details: { role: user.role },
    });

    let business = null;
    if (user.role === 'vendor') {
      const bizRes = await db.query('SELECT * FROM businesses WHERE owner_id = $1', [user.id]);
      business = bizRes.rows[0] || null;
    }

    return res.json({
      token,
      user: sanitizeUser(user),
      business,
    });
  } catch (error) {
    console.error('[Auth Login] Error:', error);
    return res.status(500).json({ message: 'Failed to log in.' });
  }
});

/**
 * POST /api/auth/forgot-password
 * Email-based password reset token request (no OTP).
 */
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ message: 'Email is required.' });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const { rows } = await db.query('SELECT id, email FROM users WHERE LOWER(email) = $1', [normalizedEmail]);

    if (rows.length === 0) {
      // Do not reveal account existence
      return res.json({
        message: 'If an account with that email exists, a password reset token has been generated.',
      });
    }

    const rawToken = crypto.randomBytes(24).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 min

    await db.query(
      'UPDATE users SET reset_token_hash = $1, reset_token_expires_at = $2 WHERE id = $3',
      [tokenHash, expiresAt, rows[0].id]
    );

    // Since hosting is 100% free/self-hosted without paid SMTP by default, return token in dev/self-hosted response
    return res.json({
      message: 'Password reset token generated. Enter it with your new password to reset.',
      resetToken: env.nodeEnv !== 'production' ? rawToken : undefined,
    });
  } catch (error) {
    console.error('[ForgotPassword] Error:', error);
    return res.status(500).json({ message: 'Failed to process password reset request.' });
  }
});

/**
 * POST /api/auth/reset-password
 */
router.post('/reset-password', async (req, res) => {
  try {
    const { email, resetToken, newPassword } = req.body;
    if (!email || !resetToken || !newPassword) {
      return res.status(400).json({ message: 'Email, reset token, and new password are required.' });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ message: 'New password must be at least 6 characters.' });
    }

    const tokenHash = crypto.createHash('sha256').update(resetToken.trim()).digest('hex');
    const { rows } = await db.query(
      `SELECT id FROM users
       WHERE LOWER(email) = $1
         AND reset_token_hash = $2
         AND reset_token_expires_at > NOW()`,
      [email.trim().toLowerCase(), tokenHash]
    );

    if (rows.length === 0) {
      return res.status(400).json({ message: 'Invalid or expired password reset token.' });
    }

    const passwordHash = await bcrypt.hash(newPassword, 12);
    await db.query(
      `UPDATE users
       SET password_hash = $1, reset_token_hash = NULL, reset_token_expires_at = NULL, updated_at = NOW()
       WHERE id = $2`,
      [passwordHash, rows[0].id]
    );

    return res.json({ message: 'Password reset successfully. You can now log in.' });
  } catch (error) {
    console.error('[ResetPassword] Error:', error);
    return res.status(500).json({ message: 'Failed to reset password.' });
  }
});

/**
 * GET /api/auth/me
 */
router.get('/me', authenticate, async (req, res) => {
  let business = null;
  if (req.user.role === 'vendor') {
    const bizRes = await db.query('SELECT * FROM businesses WHERE owner_id = $1', [req.user.id]);
    business = bizRes.rows[0] || null;
  }
  return res.json({ user: sanitizeUser(req.user), business });
});

/**
 * PUT /api/auth/profile
 */
router.put('/profile', authenticate, async (req, res) => {
  try {
    const { fullName, phone, locationLabel, latitude, longitude, vehicleType, preferredLanguage, avatarUrl } = req.body;
    const { rows } = await db.query(
      `UPDATE users SET
        full_name = COALESCE($1, full_name),
        phone = COALESCE($2, phone),
        location_label = COALESCE($3, location_label),
        latitude = COALESCE($4, latitude),
        longitude = COALESCE($5, longitude),
        vehicle_type = COALESCE($6, vehicle_type),
        preferred_language = COALESCE($7, preferred_language),
        avatar_url = COALESCE($8, avatar_url),
        updated_at = NOW()
       WHERE id = $9
       RETURNING *`,
      [
        fullName?.trim() || null,
        phone?.trim() || null,
        locationLabel?.trim() || null,
        latitude != null ? Number(latitude) : null,
        longitude != null ? Number(longitude) : null,
        vehicleType?.trim() || null,
        preferredLanguage || null,
        avatarUrl?.trim() || null,
        req.user.id,
      ]
    );

    return res.json({ user: sanitizeUser(rows[0]), message: 'Profile updated.' });
  } catch (error) {
    console.error('[Profile Update] Error:', error);
    return res.status(500).json({ message: 'Failed to update profile.' });
  }
});

/**
 * POST /api/auth/avatar
 * Upload profile image for any authenticated user (Customer, Vendor, Rider, Admin).
 */
router.post('/avatar', authenticate, upload.single('avatar'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: 'Please select an image file.' });
    }
    const avatarUrl = `/uploads/${req.file.filename}`;
    const { rows } = await db.query(
      'UPDATE users SET avatar_url = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
      [avatarUrl, req.user.id]
    );
    return res.json({ user: sanitizeUser(rows[0]), avatarUrl, message: 'Profile photo updated.' });
  } catch (error) {
    console.error('[Avatar Upload] Error:', error);
    return res.status(500).json({ message: 'Failed to upload profile photo.' });
  }
});

/**
 * PUT /api/auth/change-password
 */
router.put('/change-password', authenticate, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword || newPassword.length < 6) {
      return res.status(400).json({ message: 'Valid current and new password (6+ chars) are required.' });
    }

    const { rows } = await db.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    const valid = await bcrypt.compare(currentPassword, rows[0].password_hash);
    if (!valid) {
      return res.status(400).json({ message: 'Current password is incorrect.' });
    }

    const hash = await bcrypt.hash(newPassword, 12);
    await db.query('UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2', [hash, req.user.id]);

    return res.json({ message: 'Password updated successfully.' });
  } catch (error) {
    console.error('[ChangePassword] Error:', error);
    return res.status(500).json({ message: 'Failed to change password.' });
  }
});

module.exports = router;

