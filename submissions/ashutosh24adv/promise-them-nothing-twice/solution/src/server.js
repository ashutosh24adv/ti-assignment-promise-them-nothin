const express = require('express');
const { pool, initDb } = require('./db');
const { rateLimiterMiddleware } = require('./limiter');

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);
const NODE_NAME = process.env.NODE_NAME || 'node1';

app.use(express.json());

// Request logging middleware (helpful for debugging distributed nodes)
app.use((req, res, next) => {
  res.setHeader('X-Served-By', NODE_NAME);
  next();
});

/**
 * Health check endpoint.
 * Verifies that the instance is running and can query PostgreSQL.
 */
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    return res.status(200).json({
      status: 'healthy',
      node: NODE_NAME,
      uptime: process.uptime(),
      db: 'connected',
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    return res.status(503).json({
      status: 'unhealthy',
      node: NODE_NAME,
      error: err.message,
    });
  }
});

/**
 * Core API endpoint under rate limiting.
 */
app.get('/api/v1/ping', rateLimiterMiddleware, (req, res) => {
  return res.status(200).json({
    status: 'ok',
    message: 'pong',
    customerId: req.customerId,
    node: NODE_NAME,
    limit: req.rateLimit.limit,
    requestCount: req.rateLimit.requestCount,
    remaining: req.rateLimit.remaining,
    windowStart: req.rateLimit.windowStart,
  });
});

// 404 fallback
app.use((req, res) => {
  res.status(404).json({ error: 'not found' });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error(`[${NODE_NAME}] Unhandled server error:`, err);
  res.status(500).json({ error: 'internal server error' });
});

async function start() {
  try {
    await initDb();
    const server = app.listen(PORT, '0.0.0.0', () => {
      console.log(`[${NODE_NAME}] RelayAPI service listening on port ${PORT}`);
    });

    const shutdown = async (signal) => {
      console.log(`[${NODE_NAME}] Received ${signal}, shutting down gracefully...`);
      server.close(async () => {
        await pool.end();
        console.log(`[${NODE_NAME}] Process terminated cleanly.`);
        process.exit(0);
      });
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (err) {
    console.error(`[${NODE_NAME}] Failed to initialize service:`, err);
    process.exit(1);
  }
}

start();

module.exports = app;
