-- Configuration, authors, sources and source health.
-- All timestamps are integer epoch seconds in UTC.

CREATE TABLE topics (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  keywords_json TEXT NOT NULL DEFAULT '[]',
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1))
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL
);

CREATE TABLE authors (
  id INTEGER PRIMARY KEY,
  author_key TEXT NOT NULL UNIQUE,
  canonical_name TEXT NOT NULL
);

-- One author owns many handles across platforms; this is the author alias mechanism.
CREATE TABLE author_handles (
  author_id INTEGER NOT NULL REFERENCES authors(id),
  platform TEXT NOT NULL CHECK (platform IN ('x', 'hn', 'rss', 'github')),
  handle TEXT NOT NULL,
  UNIQUE (platform, handle)
);
CREATE INDEX author_handles_author ON author_handles(author_id);

CREATE TABLE author_baselines (
  author_id INTEGER NOT NULL REFERENCES authors(id),
  platform TEXT NOT NULL CHECK (platform IN ('x', 'hn', 'rss', 'github')),
  metric TEXT NOT NULL,
  median REAL NOT NULL,
  mad REAL NOT NULL,
  sample_size INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (author_id, platform, metric)
);

CREATE TABLE sources (
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('x', 'hn', 'rss', 'github')),
  key TEXT NOT NULL,
  label TEXT NOT NULL,
  topic_hint TEXT REFERENCES topics(slug),
  author_key TEXT REFERENCES authors(author_key),
  priority INTEGER NOT NULL DEFAULT 5,
  poll_interval_min INTEGER NOT NULL DEFAULT 60 CHECK (poll_interval_min > 0),
  always_pass INTEGER NOT NULL DEFAULT 0 CHECK (always_pass IN (0, 1)),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  next_poll_at INTEGER NOT NULL DEFAULT 0,
  cursor_json TEXT,
  UNIQUE (type, key)
);
CREATE INDEX sources_due ON sources(enabled, next_poll_at);

CREATE TABLE source_health (
  source_id INTEGER PRIMARY KEY REFERENCES sources(id),
  last_ok_at INTEGER,
  last_error_at INTEGER,
  last_error TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  items_last_poll INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE poll_log (
  id INTEGER PRIMARY KEY,
  source_id INTEGER NOT NULL REFERENCES sources(id),
  at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ok', 'error')),
  http_status INTEGER,
  items_new INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  error TEXT
);
CREATE INDEX poll_log_source_at ON poll_log(source_id, at);
CREATE INDEX poll_log_at ON poll_log(at);
