-- LLM model chain, the per-day budget ledger and the call log.

CREATE TABLE llm_models (
  model TEXT PRIMARY KEY,
  priority INTEGER NOT NULL,
  -- NULL means "no real number yet": the safe defaults from settings apply.
  rpm INTEGER,
  rpd INTEGER,
  tpm INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  exhausted_until INTEGER
);

-- Rows are created by the reservation statement itself, so a new Pacific day needs no seeding.
CREATE TABLE llm_usage (
  day_pt TEXT NOT NULL,
  model TEXT NOT NULL REFERENCES llm_models(model),
  kind TEXT NOT NULL CHECK (kind IN ('extract', 'extract_backfill', 'synthesize', 'adjudicate')),
  requests INTEGER NOT NULL DEFAULT 0 CHECK (requests >= 0),
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day_pt, model, kind)
);

CREATE TABLE llm_calls (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  model TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('extract', 'extract_backfill', 'synthesize', 'adjudicate')),
  prompt_version INTEGER NOT NULL,
  status TEXT NOT NULL,
  http_status INTEGER,
  latency_ms INTEGER,
  tokens_in INTEGER,
  tokens_out INTEGER,
  item_ids_json TEXT,
  claims_returned INTEGER,
  claims_accepted INTEGER,
  reject_reasons_json TEXT,
  error TEXT
);
CREATE INDEX llm_calls_at ON llm_calls(at);
CREATE INDEX llm_calls_model_at ON llm_calls(model, at);

INSERT INTO llm_models (model, priority) VALUES
  ('gemini-3.8-flash', 1),
  ('gemini-3.7-flash', 2),
  ('gemini-3.6-flash', 3);
