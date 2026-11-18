-- Keep the existing job IDs and foreign keys when extending the lifecycle checks.
PRAGMA defer_foreign_keys = ON;
CREATE TABLE crawl_runs_copy AS SELECT * FROM crawl_runs;
DROP TABLE crawl_runs;
CREATE TABLE crawl_runs (
  id INTEGER PRIMARY KEY,
  trigger TEXT NOT NULL CHECK (trigger IN ('manual', 'schedule')),
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'ok', 'partial', 'failed', 'stopped')),
  started_at INTEGER NOT NULL,
  finished_at INTEGER
);
INSERT INTO crawl_runs SELECT * FROM crawl_runs_copy;
DROP TABLE crawl_runs_copy;
CREATE UNIQUE INDEX crawl_one_active ON crawl_runs(status) WHERE status = 'running';
CREATE TABLE feed_runs_copy AS SELECT * FROM feed_runs;
DROP TABLE feed_runs;
CREATE TABLE feed_runs (
  id INTEGER PRIMARY KEY,
  feed TEXT NOT NULL REFERENCES feed_schedules(feed),
  crawl_id INTEGER NOT NULL REFERENCES crawl_runs(id),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed', 'stopped')),
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
INSERT INTO feed_runs SELECT * FROM feed_runs_copy;
DROP TABLE feed_runs_copy;
CREATE UNIQUE INDEX feed_one_active ON feed_runs(feed) WHERE status IN ('queued', 'running');
CREATE INDEX feed_runs_history ON feed_runs(feed, started_at);
CREATE TABLE crawl_sources_copy AS SELECT * FROM crawl_sources;
DROP TABLE crawl_sources;
CREATE TABLE crawl_sources (
  crawl_id INTEGER NOT NULL REFERENCES crawl_runs(id),
  source_id INTEGER NOT NULL REFERENCES sources(id),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'ok', 'failed', 'stopped')),
  token TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  finished_at INTEGER,
  items_new INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  PRIMARY KEY (crawl_id, source_id)
);
INSERT INTO crawl_sources SELECT * FROM crawl_sources_copy;
DROP TABLE crawl_sources_copy;

INSERT INTO settings (key, value_json) VALUES ('llm_unlimited', 'true') ON CONFLICT(key) DO NOTHING;
