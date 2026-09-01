-- Schema initialization for RelayAPI Rate Limiter
CREATE TABLE IF NOT EXISTS rate_limit_windows (
    customer_id VARCHAR(64) NOT NULL,
    window_start TIMESTAMPTZ NOT NULL,
    request_count INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (customer_id, window_start)
);

CREATE INDEX IF NOT EXISTS idx_rate_limit_windows_window_start
ON rate_limit_windows (window_start);
