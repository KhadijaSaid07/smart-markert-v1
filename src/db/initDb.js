const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const env = require('../config/env');
const db = require('../config/db');
const { runDataInitializer } = require('./DataInitializer');

async function ensureDatabaseExists() {
  // Managed cloud Postgres (Render, Neon, Supabase, etc.) pre-creates the database
  if (
    env.db.connectionString ||
    (env.db.host && env.db.host !== 'localhost' && env.db.host !== '127.0.0.1')
  ) {
    return;
  }

  const client = new Client({
    host: env.db.host,
    port: env.db.port,
    user: env.db.user,
    password: env.db.password,
    database: 'postgres',
  });

  await client.connect();
  const res = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [env.db.database]);
  if (res.rowCount === 0) {
    await client.query(`CREATE DATABASE "${env.db.database}"`);
    console.log(`[DB Init] Created database "${env.db.database}"`);
  }
  await client.end();
}

async function initDatabase() {
  await ensureDatabaseExists();
  const schemaPath = path.join(__dirname, 'schema.sql');
  const schemaSql = fs.readFileSync(schemaPath, 'utf8');
  await db.query(schemaSql);
  await db.query(
    "ALTER TABLE products_services ADD COLUMN IF NOT EXISTS images JSONB NOT NULL DEFAULT '[]'::jsonb"
  );
  console.log('[DB Init] Schema applied successfully.');
  await runDataInitializer();
}

if (require.main === module) {
  initDatabase()
    .then(() => {
      console.log('[DB Init] Done.');
      process.exit(0);
    })
    .catch((err) => {
      console.error('[DB Init] Error:', err);
      process.exit(1);
    });
}

module.exports = { initDatabase };

