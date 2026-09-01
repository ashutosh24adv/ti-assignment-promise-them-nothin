const { Pool } = require('pg');

const databaseUrl = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/relayapi';

const pool = new Pool({
  connectionString: databaseUrl,
  max: parseInt(process.env.PG_MAX_CONNECTIONS || '25', 10),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('[PostgreSQL Pool Error]', err.message);
});

/**
 * Initializes the database schema using an advisory lock to prevent catalog concurrency race conditions
 * when multiple application nodes start simultaneously.
 */
async function initDb(retries = 5, delayMs = 2000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // Acquire an application-level advisory lock for schema migration (hash of 'relayapi_rate_limiter_init')
        await client.query('SELECT pg_advisory_xact_lock(7492841)');
        
        await client.query(`
          CREATE TABLE IF NOT EXISTS rate_limit_windows (
            customer_id VARCHAR(64) NOT NULL,
            window_start TIMESTAMPTZ NOT NULL,
            request_count INTEGER NOT NULL DEFAULT 1,
            PRIMARY KEY (customer_id, window_start)
          );

          CREATE INDEX IF NOT EXISTS idx_rate_limit_windows_window_start
          ON rate_limit_windows (window_start);
        `);
        
        await client.query('COMMIT');
        console.log(`[Database] Schema initialized successfully.`);
        return;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    } catch (err) {
      console.warn(`[Database] Initialization attempt ${attempt}/${retries} failed: ${err.message}`);
      if (attempt === retries) {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

module.exports = {
  pool,
  initDb,
};
