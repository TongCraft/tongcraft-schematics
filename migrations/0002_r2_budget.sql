CREATE TABLE IF NOT EXISTS storage_budget (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  used_bytes INTEGER NOT NULL DEFAULT 0 CHECK (used_bytes >= 0)
);
INSERT OR IGNORE INTO storage_budget(id, used_bytes)
SELECT 1, COALESCE(SUM(file_size), 0) FROM items WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS r2_daily_usage (
  day TEXT PRIMARY KEY,
  puts INTEGER NOT NULL DEFAULT 0 CHECK (puts >= 0),
  gets INTEGER NOT NULL DEFAULT 0 CHECK (gets >= 0)
);
