/**
 * Disaster Recovery Restore Script
 * Usage: node scripts/restore_from_json.js <path-to-snapshot.json>
 * Restores all JamiiMarket tables from a portable JSON backup snapshot.
 */
const fs = require('fs');
const path = require('path');
const db = require('../src/config/db');
const { initDatabase } = require('../src/db/initDb');

const TABLE_ORDER = [
  'users',
  'businesses',
  'products_services',
  'favorites',
  'cart_items',
  'orders',
  'order_items',
  'service_bookings',
  'deliveries',
  'payments',
  'escrow_wallets',
  'escrow_transactions',
  'user_behaviors',
  'trip_analytics',
  'notifications',
  'feedback',
  'audit_logs',
];

async function restore(snapshotPath) {
  const absPath = path.resolve(snapshotPath);
  if (!fs.existsSync(absPath)) {
    throw new Error(`Snapshot file not found: ${absPath}`);
  }

  await initDatabase();
  const snapshot = JSON.parse(fs.readFileSync(absPath, 'utf8'));

  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    for (const table of TABLE_ORDER) {
      const rows = snapshot.tables?.[table] || [];
      for (const row of rows) {
        const cols = Object.keys(row);
        if (cols.length === 0) continue;
        const placeholders = cols.map((_, idx) => `$${idx + 1}`).join(', ');
        const values = cols.map((c) => {
          const v = row[c];
          if (v !== null && typeof v === 'object' && !(v instanceof Date)) {
            return JSON.stringify(v);
          }
          return v;
        });
        await client.query(
          `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`,
          values
        );
      }
      console.log(`[Restore] ${table}: ${rows.length} rows processed`);
    }
    await client.query('COMMIT');
    console.log('[Restore] Completed successfully.');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

const arg = process.argv[2];
if (!arg) {
  console.error('Usage: node scripts/restore_from_json.js <path-to-snapshot.json>');
  process.exit(1);
}

restore(arg)
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[Restore] Failed:', err.message);
    process.exit(1);
  });

