const { Pool } = require('pg');
const env = require('./env');

const isRemoteHost =
  Boolean(env.db.connectionString) ||
  (env.db.host && env.db.host !== 'localhost' && env.db.host !== '127.0.0.1');

const useSsl = env.db.ssl || (isRemoteHost && process.env.DB_SSL !== 'false');

const poolConfig = env.db.connectionString
  ? {
      connectionString: env.db.connectionString,
      ssl: useSsl ? { rejectUnauthorized: false } : false,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 15000,
    }
  : {
      host: env.db.host,
      port: env.db.port,
      database: env.db.database,
      user: env.db.user,
      password: env.db.password,
      ssl: useSsl ? { rejectUnauthorized: false } : false,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 15000,
    };

const pool = new Pool(poolConfig);

pool.on('error', (err) => {
  console.error('[PostgreSQL] Unexpected pool error:', err.message);
});

const query = (text, params) => pool.query(text, params);

const getClient = () => pool.connect();

module.exports = {
  pool,
  query,
  getClient,
};

