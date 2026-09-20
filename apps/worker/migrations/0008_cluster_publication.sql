-- Staging for atomic cluster publication. This must be a new migration because
-- existing databases have already applied the original graph schema.
-- IF NOT EXISTS also supports checkouts that applied the briefly amended 0004.
CREATE TABLE IF NOT EXISTS run_stories (
  run_id INTEGER NOT NULL REFERENCES cluster_runs(id),
  story_id INTEGER NOT NULL REFERENCES stories(id),
  label_entity_id INTEGER,
  label_text TEXT,
  fallback_headline TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('lead', 'ready')),
  score REAL NOT NULL,
  subscores_json TEXT NOT NULL,
  independent_sources INTEGER NOT NULL,
  has_counter INTEGER NOT NULL CHECK (has_counter IN (0, 1)),
  topics_json TEXT NOT NULL,
  search_text TEXT NOT NULL,
  entity_signature_json TEXT NOT NULL,
  members_hash TEXT NOT NULL,
  first_claim_at INTEGER NOT NULL,
  last_claim_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, story_id)
);

-- Stories this run ends: absorbed by a merge (heir set) or dead (heir NULL).
CREATE TABLE IF NOT EXISTS run_retirements (
  run_id INTEGER NOT NULL REFERENCES cluster_runs(id),
  story_id INTEGER NOT NULL REFERENCES stories(id),
  heir_story_id INTEGER REFERENCES stories(id),
  PRIMARY KEY (run_id, story_id)
);
