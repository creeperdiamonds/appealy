-- migrations/0002_tick_lock.sql
--
-- One row per minute that has been checked. Whoever inserts the row first —
-- the cron, or a request that found the data stale — does that minute's work;
-- everyone else sees the insert do nothing and skips it. Without this, two
-- visitors in the same minute would each add a minute to the daily counts.
CREATE TABLE IF NOT EXISTS ticks (
  minute INTEGER PRIMARY KEY
) WITHOUT ROWID;
