-- Durable ingestion runs and independently published editorial feeds.
ALTER TABLE items ADD COLUMN editorial_attempts INTEGER NOT NULL DEFAULT 0;
CREATE TABLE crawl_runs (
  id INTEGER PRIMARY KEY,
  trigger TEXT NOT NULL CHECK (trigger IN ('manual', 'schedule')),
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'ok', 'partial', 'failed')),
  started_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE UNIQUE INDEX crawl_one_active ON crawl_runs(status) WHERE status = 'running';

CREATE TABLE crawl_sources (
  crawl_id INTEGER NOT NULL REFERENCES crawl_runs(id),
  source_id INTEGER NOT NULL REFERENCES sources(id),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'ok', 'failed')),
  token TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  finished_at INTEGER,
  items_new INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  PRIMARY KEY (crawl_id, source_id)
);

CREATE TABLE crawl_items (
  crawl_id INTEGER NOT NULL REFERENCES crawl_runs(id),
  item_id INTEGER NOT NULL REFERENCES items(id),
  snapshot_json TEXT NOT NULL,
  PRIMARY KEY (crawl_id, item_id)
);
CREATE INDEX crawl_items_item ON crawl_items(item_id, crawl_id);

CREATE TABLE item_editorial (
  item_id INTEGER PRIMARY KEY REFERENCES items(id),
  content_hash TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('news', 'tool', 'field_test', 'playbook', 'deep_dive', 'other')),
  pillar TEXT NOT NULL,
  summary_vi TEXT NOT NULL,
  question_vi TEXT,
  model TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE repository_snapshots (
  item_id INTEGER NOT NULL REFERENCES items(id),
  captured_at INTEGER NOT NULL,
  data_json TEXT NOT NULL,
  PRIMARY KEY (item_id, captured_at)
);

CREATE TABLE feed_schedules (
  feed TEXT PRIMARY KEY CHECK (feed IN ('news', 'hands-on', 'deep-dives')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  interval_minutes INTEGER NOT NULL CHECK (interval_minutes BETWEEN 30 AND 10080),
  next_run_at INTEGER NOT NULL DEFAULT 0
);
INSERT INTO feed_schedules (feed, interval_minutes) VALUES ('news', 60), ('hands-on', 1440), ('deep-dives', 1440);

CREATE TABLE feed_runs (
  id INTEGER PRIMARY KEY,
  feed TEXT NOT NULL REFERENCES feed_schedules(feed),
  crawl_id INTEGER NOT NULL REFERENCES crawl_runs(id),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
  trigger TEXT NOT NULL CHECK (trigger IN ('manual', 'schedule')),
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  token TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  item_count INTEGER NOT NULL DEFAULT 0,
  metadata_json TEXT NOT NULL DEFAULT '{}'
);
CREATE UNIQUE INDEX feed_one_active ON feed_runs(feed) WHERE status IN ('queued', 'running');
CREATE INDEX feed_runs_history ON feed_runs(feed, started_at);

-- Entry payloads are immutable once their run is published. A failed attempt is invisible.
CREATE TABLE feed_entries (
  run_id INTEGER NOT NULL REFERENCES feed_runs(id),
  entry_key TEXT NOT NULL,
  category TEXT NOT NULL,
  pillar TEXT NOT NULL,
  score REAL NOT NULL,
  published_at INTEGER NOT NULL,
  search_text TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (run_id, entry_key)
);
CREATE INDEX feed_entries_rank ON feed_entries(run_id, category, score DESC, entry_key);
CREATE TABLE feed_publications (
  feed TEXT PRIMARY KEY REFERENCES feed_schedules(feed),
  run_id INTEGER NOT NULL REFERENCES feed_runs(id)
);
CREATE TABLE feed_read_state (
  entry_key TEXT PRIMARY KEY,
  read_at INTEGER NOT NULL
);
