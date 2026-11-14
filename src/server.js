const http = require('http');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const cron = require('node-cron');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');

const env = require('./config/env');
const { initDatabase } = require('./db/initDb');
const { uploadDir } = require('./middleware/upload');
const { setSocketIO } = require('./services/notificationService');
const { runBackup } = require('./services/backupService');
const { triggerOffPeakTraining } = require('./services/aiService');

const authRoutes = require('./routes/auth.routes');
const adminRoutes = require('./routes/admin.routes');
const businessRoutes = require('./routes/business.routes');
const productRoutes = require('./routes/product.routes');
const cartRoutes = require('./routes/cart.routes');
const orderRoutes = require('./routes/order.routes');
const bookingRoutes = require('./routes/booking.routes');
const deliveryRoutes = require('./routes/delivery.routes');
const paymentRoutes = require('./routes/payment.routes');
const aiRoutes = require('./routes/ai.routes');
const feedbackRoutes = require('./routes/feedback.routes');
const notificationRoutes = require('./routes/notification.routes');
const favoritesRoutes = require('./routes/favorites.routes');

const app = express();
const server = http.createServer(app);

const corsOriginCheck = (origin, callback) => {
  if (!origin || env.corsOrigins.includes(origin)) {
    return callback(null, true);
  }
  return callback(null, true); // Allow Netlify previews or configured origins
};

const io = new Server(server, {
  cors: {
    origin: corsOriginCheck,
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    credentials: true,
  },
});

setSocketIO(io);

io.use((socket, next) => {
  const token = socket.handshake.auth?.token || socket.handshake.query?.token;
  if (!token) return next();
  try {
    const decoded = jwt.verify(token, env.jwt.secret);
    socket.user = decoded;
  } catch {
    // allow anonymous socket or ignore invalid token
  }
  next();
});

io.on('connection', (socket) => {
  if (socket.user) {
    socket.join(`user:${socket.user.userId}`);
    socket.join(`role:${socket.user.role}`);
  }
});

// Middleware
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(compression());
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || env.corsOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(null, true); // Allow Netlify previews or configured origins
    },
    credentials: true,
  })
);
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan(env.nodeEnv === 'production' ? 'combined' : 'dev'));

// Static uploaded images
app.use('/uploads', express.static(uploadDir));

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'JamiiMarket Backend API',
    timestamp: new Date().toISOString(),
  });
});

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/businesses', businessRoutes);
app.use('/api/products', productRoutes);
app.use('/api/cart', cartRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/bookings', bookingRoutes);
app.use('/api/delivery', deliveryRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/feedback', feedbackRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/favorites', favoritesRoutes);

// Global error handler
app.use((err, req, res, next) => {
  console.error('[Unhandled Error]', err);
  res.status(err.status || 500).json({
    message: err.message || 'Internal server error.',
  });
});

async function startServer() {
  try {
    await initDatabase();

    // Schedule daily system backups (default: 2:00 AM)
    cron.schedule(env.backup.cron, () => {
      runBackup('cron-daily').catch((err) =>
        console.error('[Cron Backup] Error:', err.message)
      );
    });

    // Schedule off-peak TensorFlow.js training (default: 2:30 AM)
    cron.schedule(env.ai.trainCron, () => {
      triggerOffPeakTraining().catch((err) =>
        console.error('[Cron AI] Error:', err.message)
      );
    });

    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(
          `[JamiiMarket API] Port ${env.port} is already in use. Stop the existing server (e.g. "fuser -k ${env.port}/tcp") or set a different PORT in .env.`
        );
        process.exit(1);
      }
      console.error('[JamiiMarket API] Server error:', err);
      process.exit(1);
    });

    server.listen(env.port, () => {
      console.log(`[JamiiMarket API] Listening on port ${env.port} (${env.nodeEnv})`);
    });
  } catch (err) {
    console.error('[JamiiMarket API] Startup failed:', err.message || err.code || err);
    if (!env.db.connectionString && (env.db.host === 'localhost' || env.db.host === '127.0.0.1')) {
      console.error(
        '[JamiiMarket API] Hint: No DATABASE_URL found and DB_HOST is localhost. On Render, create a Render PostgreSQL database and set DATABASE_URL in your Web Service Environment Variables.'
      );
    }
    console.error('Make sure PostgreSQL is running and credentials in .env are valid.');
    process.exit(1);
  }
}

if (require.main === module) {
  startServer();
}

module.exports = { app, server, startServer };

