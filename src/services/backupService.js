const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const env = require('../config/env');
const db = require('../config/db');

const execFileAsync = promisify(execFile);

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function copyDirRecursive(src, dest) {
  if (!fs.existsSync(src)) return;
  ensureDir(dest);
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * Exports all critical PostgreSQL tables to JSON as a portable disaster-recovery snapshot
 * in addition to pg_dump SQL so data can always be restored even on a fresh machine.
 */
async function exportJsonSnapshot(targetFile) {
  const tables = [
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

  const snapshot = {
    exportedAt: new Date().toISOString(),
    database: env.db.database,
    tables: {},
  };

  for (const table of tables) {
    const { rows } = await db.query(`SELECT * FROM ${table}`);
    snapshot.tables[table] = rows;
  }

  fs.writeFileSync(targetFile, JSON.stringify(snapshot, null, 2), 'utf8');
}

/**
 * Creates a timestamped backup folder containing:
 *  - database.sql (pg_dump custom/plain SQL)
 *  - snapshot.json (portable JSON snapshot)
 *  - uploads/ (vendor banners & product images)
 *  - ai_models/ (trained TF.js weights)
 * Also mirrors to EXTERNAL_BACKUP_DIR if configured.
 */
async function runBackup(reason = 'scheduled') {
  ensureDir(env.backup.dir);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupName = `jamii-backup-${stamp}`;
  const backupPath = path.join(env.backup.dir, backupName);
  ensureDir(backupPath);

  const sqlFile = path.join(backupPath, 'database.sql');
  const jsonFile = path.join(backupPath, 'snapshot.json');
  let pgDumpSuccess = false;

  try {
    await execFileAsync(
      'pg_dump',
      [
        '-h', env.db.host,
        '-p', String(env.db.port),
        '-U', env.db.user,
        '-d', env.db.database,
        '--no-owner',
        '--no-privileges',
        '-f', sqlFile,
      ],
      {
        env: { ...process.env, PGPASSWORD: env.db.password },
        timeout: 120000,
      }
    );
    pgDumpSuccess = true;
  } catch (err) {
    console.warn('[BackupService] pg_dump failed, relying on JSON snapshot:', err.message);
  }

  await exportJsonSnapshot(jsonFile);

  const uploadsSrc = path.resolve(__dirname, '../../uploads');
  copyDirRecursive(uploadsSrc, path.join(backupPath, 'uploads'));

  if (fs.existsSync(env.ai.modelDir)) {
    copyDirRecursive(env.ai.modelDir, path.join(backupPath, 'ai_models'));
  }

  const manifest = {
    backupName,
    reason,
    createdAt: new Date().toISOString(),
    pgDumpSuccess,
    hasJsonSnapshot: fs.existsSync(jsonFile),
  };
  fs.writeFileSync(path.join(backupPath, 'manifest.json'), JSON.stringify(manifest, null, 2));

  // Mirror to external directory (e.g., USB, secondary drive, or cloud-synced folder)
  if (env.backup.externalDir) {
    try {
      ensureDir(env.backup.externalDir);
      copyDirRecursive(backupPath, path.join(env.backup.externalDir, backupName));
      manifest.externalMirror = env.backup.externalDir;
    } catch (extErr) {
      console.error('[BackupService] External mirror failed:', extErr.message);
    }
  }

  pruneOldBackups();
  console.log(`[BackupService] Backup created: ${backupName}`);
  return manifest;
}

function pruneOldBackups() {
  if (!fs.existsSync(env.backup.dir)) return;
  const cutoffMs = Date.now() - env.backup.retentionDays * 24 * 60 * 60 * 1000;
  for (const entry of fs.readdirSync(env.backup.dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('jamii-backup-')) continue;
    const fullPath = path.join(env.backup.dir, entry.name);
    const stat = fs.statSync(fullPath);
    if (stat.mtimeMs < cutoffMs) {
      fs.rmSync(fullPath, { recursive: true, force: true });
    }
  }
}

function listBackups() {
  ensureDir(env.backup.dir);
  return fs
    .readdirSync(env.backup.dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith('jamii-backup-'))
    .map((d) => {
      const manifestPath = path.join(env.backup.dir, d.name, 'manifest.json');
      if (fs.existsSync(manifestPath)) {
        return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      }
      return { backupName: d.name };
    })
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
}

module.exports = {
  runBackup,
  listBackups,
  pruneOldBackups,
};

