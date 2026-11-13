const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const parseOrigins = (value) => {
  if (!value) return ['http://localhost:5173'];
  return value
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
};

module.exports = {
  port: Number(process.env.PORT) || 5000,
  nodeEnv: process.env.NODE_ENV || 'development',
  db: {
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 5432,
    database: process.env.DB_NAME || 'smart-markert-db',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'J@miiMarkert$123',
  },
  jwt: {
    secret: process.env.JWT_SECRET || 'jamii_market_dev_secret',
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  },
  corsOrigins: parseOrigins(process.env.CORS_ORIGINS),
  backup: {
    dir: path.resolve(__dirname, '../../', process.env.BACKUP_DIR || './backups'),
    externalDir: process.env.EXTERNAL_BACKUP_DIR
      ? path.resolve(process.env.EXTERNAL_BACKUP_DIR)
      : null,
    retentionDays: Number(process.env.BACKUP_RETENTION_DAYS) || 30,
    cron: process.env.BACKUP_CRON || '0 2 * * *',
  },
  ai: {
    trainCron: process.env.AI_TRAIN_CRON || '30 2 * * *',
    modelDir: path.resolve(__dirname, '../../ai_models'),
  },
  payments: {
    mode: process.env.PAYMENT_MODE || 'sandbox',
    mpesaEnv: process.env.MPESA_ENV || 'sandbox',
    mpesaConsumerKey: process.env.MPESA_CONSUMER_KEY || '',
    mpesaConsumerSecret: process.env.MPESA_CONSUMER_SECRET || '',
    mpesaShortcode: process.env.MPESA_SHORTCODE || '174379',
    mpesaPasskey: process.env.MPESA_PASSKEY || '',
    mpesaCallbackUrl: process.env.MPESA_CALLBACK_URL || '',
  },
};

