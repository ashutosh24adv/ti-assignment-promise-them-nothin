const { pool } = require('./db');
const { getCustomerLimit } = require('./config');

/**
 * Middleware: Enforces per-customer rate limits using PostgreSQL atomic upserts.
 * 
 * Identity & Validation Semantics:
 * - Customer identity must be supplied via trusted 'X-Customer-Id' header.
 * - Missing or whitespace-only header returns 400 Bad Request.
 * - Unregistered / unknown customer ID returns 400 Bad Request.
 * - Valid customers are metered via fixed wall-clock UTC minute window using
 *   an atomic PostgreSQL conditional upsert.
 * - Fail-closed: Database outages return 503 Service Unavailable.
 */
async function rateLimiterMiddleware(req, res, next) {
  const rawCustomerId = req.header('X-Customer-Id');

  // Reject missing or blank X-Customer-Id header with 400 Bad Request
  if (!rawCustomerId || !rawCustomerId.trim()) {
    return res.status(400).json({
      error: 'missing or invalid X-Customer-Id header',
    });
  }

  const customerId = rawCustomerId.trim().toLowerCase();
  const limit = getCustomerLimit(customerId);

  // Reject unregistered / unknown customer ID with 400 Bad Request
  if (limit === null || limit === undefined) {
    return res.status(400).json({
      error: 'unknown or unconfigured customer ID',
      customerId,
    });
  }

  // If customer limit is 0 or negative, immediately reject with 429
  if (limit <= 0) {
    const now = Date.now();
    const windowStartMs = Math.floor(now / 60000) * 60000;
    const retryAfter = Math.max(1, Math.ceil((windowStartMs + 60000 - now) / 1000));
    res.setHeader('Retry-After', String(retryAfter));
    res.setHeader('X-RateLimit-Limit', String(limit));
    res.setHeader('X-RateLimit-Remaining', '0');
    return res.status(429).json({
      error: 'rate limit exceeded',
      customerId,
      limit,
      retryAfter,
    });
  }

  const now = new Date();
  const currentEpochMs = now.getTime();
  const windowStartMs = Math.floor(currentEpochMs / 60000) * 60000;
  const windowStartDate = new Date(windowStartMs);
  const nextWindowMs = windowStartMs + 60000;
  const retryAfter = Math.max(1, Math.ceil((nextWindowMs - currentEpochMs) / 1000));

  const query = `
    INSERT INTO rate_limit_windows (customer_id, window_start, request_count)
    VALUES ($1, $2, 1)
    ON CONFLICT (customer_id, window_start)
    DO UPDATE
    SET request_count = rate_limit_windows.request_count + 1
    WHERE rate_limit_windows.request_count < $3
    RETURNING request_count;
  `;

  try {
    const result = await pool.query(query, [customerId, windowStartDate.toISOString(), limit]);

    if (result.rows.length > 0) {
      // Slot acquired successfully
      const currentCount = result.rows[0].request_count;
      const remaining = Math.max(0, limit - currentCount);

      req.customerId = customerId;
      req.rateLimit = {
        allowed: true,
        limit,
        requestCount: currentCount,
        remaining,
        windowStart: windowStartDate.toISOString(),
        retryAfter,
      };

      res.setHeader('X-RateLimit-Limit', String(limit));
      res.setHeader('X-RateLimit-Remaining', String(remaining));
      res.setHeader('X-RateLimit-Reset', String(Math.floor(nextWindowMs / 1000)));

      return next();
    } else {
      // Quota exhausted for current window (WHERE clause condition prevented update)
      res.setHeader('Retry-After', String(retryAfter));
      res.setHeader('X-RateLimit-Limit', String(limit));
      res.setHeader('X-RateLimit-Remaining', '0');
      res.setHeader('X-RateLimit-Reset', String(Math.floor(nextWindowMs / 1000)));

      return res.status(429).json({
        error: 'rate limit exceeded',
        customerId,
        limit,
        retryAfter,
      });
    }
  } catch (err) {
    console.error(`[RateLimiter] Database error for customer '${customerId}':`, err.message);

    // Fail-closed: Return 503 rather than allowing unmetered quota breaches
    res.setHeader('Retry-After', '5');
    return res.status(503).json({
      error: 'rate limit backend unavailable',
      status: 503,
      message: 'Unable to verify rate limit quota. Request rejected to protect system integrity.',
    });
  }
}

module.exports = {
  rateLimiterMiddleware,
};
