const bcrypt = require('bcrypt');
const db = require('../config/db');

/**
 * DataInitializer
 * -----------------
 * Seeds the initial System Administrator account on startup if it does not exist.
 * You can edit the default admin email/password below before deploying to production.
 */
const DEFAULT_ADMIN = {
  fullName: 'JamiiMarket System Admin',
  email: 'admin@smflb.com',
  password: '@Admin.smflb@21',
  phone: '+255675788310',
};

async function runDataInitializer() {
  try {
    const existingAdmin = await db.query(
      'SELECT id, email FROM users WHERE LOWER(email) = LOWER($1)',
      [DEFAULT_ADMIN.email]
    );

    if (existingAdmin.rows.length === 0) {
      const passwordHash = await bcrypt.hash(DEFAULT_ADMIN.password, 12);
      const result = await db.query(
        `INSERT INTO users (
          full_name, email, phone, password_hash, role, approval_status, is_active
        ) VALUES ($1, $2, $3, $4, 'admin', 'approved', TRUE)
        RETURNING id, email`,
        [
          DEFAULT_ADMIN.fullName,
          DEFAULT_ADMIN.email.toLowerCase(),
          DEFAULT_ADMIN.phone,
          passwordHash,
        ]
      );

      // Ensure admin also has an escrow wallet record if needed
      await db.query(
        `INSERT INTO escrow_wallets (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`,
        [result.rows[0].id]
      );

      console.log(`[DataInitializer] Created default admin account: ${result.rows[0].email}`);
    } else {
      console.log(`[DataInitializer] Default admin already exists: ${existingAdmin.rows[0].email}`);
    }
  } catch (error) {
    console.error('[DataInitializer] Failed to initialize data:', error.message);
    throw error;
  }
}

module.exports = {
  DEFAULT_ADMIN,
  runDataInitializer,
};
