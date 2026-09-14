-- migrations/0001_init.sql
--
-- Applied with: npx wrangler d1 migrations apply appealy-status --remote

-- The bot's most recent heartbeat. One row, overwritten every 30s.
CREATE TABLE IF NOT EXISTS heartbeat (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  received_at INTEGER NOT NULL,
  body TEXT NOT NULL
);

-- Minutes spent in each state, per component per UTC day. WITHOUT ROWID makes
-- the primary key the table itself, so an upsert writes one row rather than
-- one to the table and another to a separate index.
CREATE TABLE IF NOT EXISTS daily (
  day TEXT NOT NULL,
  component TEXT NOT NULL,
  up INTEGER NOT NULL DEFAULT 0,
  degraded INTEGER NOT NULL DEFAULT 0,
  down INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, component)
) WITHOUT ROWID;

-- What /status.json serves, rebuilt by the cron every minute. Serving a
-- prebuilt row keeps a page view at one row read instead of ninety days' worth.
CREATE TABLE IF NOT EXISTS summary (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  generated_at INTEGER NOT NULL,
  body TEXT NOT NULL
);
