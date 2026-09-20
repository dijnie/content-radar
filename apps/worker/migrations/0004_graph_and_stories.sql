-- Claim graph, cluster runs, lineage, stories (cards) and daily aggregates.

-- Only the invariant part of an edge is stored; the entity part is recomputed per run.
CREATE TABLE claim_edges (
  claim_a INTEGER NOT NULL REFERENCES claims(id),
  claim_b INTEGER NOT NULL REFERENCES claims(id),
  cosine REAL NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (claim_a, claim_b),
  CHECK (claim_a < claim_b)
);
CREATE INDEX claim_edges_b ON claim_edges(claim_b);

CREATE TABLE job_leases (
  name TEXT PRIMARY KEY,
  holder TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE cluster_runs (
  id INTEGER PRIMARY KEY,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  heartbeat_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'failed')),
  stage TEXT,
  params_json TEXT NOT NULL,
  seed INTEGER NOT NULL,
  node_count INTEGER,
  edge_count INTEGER,
  community_count INTEGER,
  quality REAL,
  error TEXT
);
CREATE INDEX cluster_runs_status ON cluster_runs(status, finished_at);

CREATE TABLE stories (
  id INTEGER PRIMARY KEY,
  label_entity_id INTEGER REFERENCES entities(id),
  label_text TEXT,
  headline_vi TEXT NOT NULL,
  headline_source TEXT NOT NULL DEFAULT 'fallback' CHECK (headline_source IN ('fallback', 'llm')),
  status TEXT NOT NULL DEFAULT 'lead' CHECK (status IN ('lead', 'ready')),
  score REAL NOT NULL DEFAULT 0,
  subscores_json TEXT NOT NULL DEFAULT '{}',
  independent_sources INTEGER NOT NULL DEFAULT 0,
  questions_json TEXT NOT NULL DEFAULT '[]',
  has_counter INTEGER NOT NULL DEFAULT 0 CHECK (has_counter IN (0, 1)),
  topics_json TEXT NOT NULL DEFAULT '[]',
  search_text TEXT NOT NULL DEFAULT '',
  entity_signature_json TEXT NOT NULL DEFAULT '[]',
  user_state TEXT NOT NULL DEFAULT 'inbox' CHECK (user_state IN ('inbox', 'saved', 'dismissed', 'written')),
  user_state_at INTEGER,
  first_seen_at INTEGER NOT NULL,
  last_claim_at INTEGER NOT NULL,
  members_hash TEXT NOT NULL,
  -- State at the last LLM synthesis, used to decide whether the story changed enough to deserve another call.
  synthesized_hash TEXT,
  synthesized_at INTEGER,
  synthesized_sources INTEGER,
  synthesized_run_id INTEGER,
  -- Attempts for the current members_hash; reset when membership changes.
  synthesis_attempts INTEGER NOT NULL DEFAULT 0,
  alive INTEGER NOT NULL DEFAULT 1 CHECK (alive IN (0, 1)),
  died_at INTEGER
);
CREATE INDEX stories_feed ON stories(alive, user_state, score);
CREATE INDEX stories_died ON stories(alive, died_at);

CREATE TABLE run_communities (
  run_id INTEGER NOT NULL REFERENCES cluster_runs(id),
  community_idx INTEGER NOT NULL,
  story_id INTEGER NOT NULL REFERENCES stories(id),
  size INTEGER NOT NULL,
  members_hash TEXT NOT NULL,
  PRIMARY KEY (run_id, community_idx)
);
CREATE INDEX run_communities_story ON run_communities(story_id);

CREATE TABLE run_members (
  run_id INTEGER NOT NULL,
  community_idx INTEGER NOT NULL,
  claim_id INTEGER NOT NULL REFERENCES claims(id),
  PRIMARY KEY (run_id, community_idx, claim_id),
  FOREIGN KEY (run_id, community_idx) REFERENCES run_communities(run_id, community_idx)
);

-- Staging for one run. Rows here are invisible to readers; the publish step copies
-- them into `stories` and `story_claims` in a single transaction.
CREATE TABLE run_stories (
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
CREATE TABLE run_retirements (
  run_id INTEGER NOT NULL REFERENCES cluster_runs(id),
  story_id INTEGER NOT NULL REFERENCES stories(id),
  heir_story_id INTEGER REFERENCES stories(id),
  PRIMARY KEY (run_id, story_id)
);

CREATE TABLE lineage_events (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES cluster_runs(id),
  type TEXT NOT NULL CHECK (type IN ('birth', 'continue', 'split', 'merge', 'death', 'revive')),
  story_id INTEGER NOT NULL REFERENCES stories(id),
  related_story_id INTEGER REFERENCES stories(id),
  jaccard REAL,
  at INTEGER NOT NULL
);
CREATE INDEX lineage_events_run ON lineage_events(run_id);
CREATE INDEX lineage_events_story ON lineage_events(story_id, at);

-- Current membership projection. Roles describe the claim's relation to the story.
CREATE TABLE story_claims (
  story_id INTEGER NOT NULL REFERENCES stories(id),
  claim_id INTEGER NOT NULL REFERENCES claims(id),
  role TEXT NOT NULL DEFAULT 'unassigned' CHECK (role IN ('evidence', 'context', 'counter', 'unassigned')),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  added_run_id INTEGER NOT NULL REFERENCES cluster_runs(id),
  removed_run_id INTEGER REFERENCES cluster_runs(id),
  PRIMARY KEY (story_id, claim_id)
);
CREATE INDEX story_claims_claim ON story_claims(claim_id, active);

CREATE TABLE user_actions (
  id INTEGER PRIMARY KEY,
  story_id INTEGER NOT NULL REFERENCES stories(id),
  action TEXT NOT NULL CHECK (action IN ('save', 'dismiss', 'written', 'restore')),
  at INTEGER NOT NULL,
  score_at_action REAL,
  subscores_json TEXT
);
CREATE INDEX user_actions_story ON user_actions(story_id, at);

-- `day` is the UTC date (YYYY-MM-DD) of claims.published_at, so backfilled data fills history.
CREATE TABLE story_daily (
  story_id INTEGER NOT NULL REFERENCES stories(id),
  day TEXT NOT NULL,
  claim_count INTEGER NOT NULL,
  source_count INTEGER NOT NULL,
  score REAL,
  engagement REAL,
  PRIMARY KEY (story_id, day)
);

CREATE TABLE entity_daily (
  entity_id INTEGER NOT NULL REFERENCES entities(id),
  day TEXT NOT NULL,
  claim_count INTEGER NOT NULL,
  author_count INTEGER NOT NULL,
  engagement REAL,
  PRIMARY KEY (entity_id, day)
);
CREATE INDEX entity_daily_day ON entity_daily(day);
