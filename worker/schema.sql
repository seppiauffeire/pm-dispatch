CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device TEXT NOT NULL,
  name TEXT NOT NULL,
  score INTEGER NOT NULL,
  grade TEXT NOT NULL,
  arch TEXT NOT NULL,
  prob INTEGER NOT NULL,
  combos INTEGER NOT NULL,
  picks TEXT NOT NULL,
  luck TEXT NOT NULL,
  week TEXT NOT NULL,
  ip TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runs_week_score ON runs (week, score DESC);
CREATE INDEX IF NOT EXISTS idx_runs_device ON runs (device, score DESC);
CREATE INDEX IF NOT EXISTS idx_runs_ip_time ON runs (ip, created_at);
