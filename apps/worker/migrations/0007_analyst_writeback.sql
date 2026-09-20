-- What analyst sessions write back, so each session inherits the previous ones.
-- Both tables are append-only: rows can change status, never vanish or be re-attributed.

CREATE TABLE analyst_signals (
  id INTEGER PRIMARY KEY,
  created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER)),
  session_label TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('anomaly', 'trend', 'shift')),
  title TEXT NOT NULL,
  summary_vi TEXT NOT NULL,
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  story_ids_json TEXT NOT NULL DEFAULT '[]',
  entity_ids_json TEXT NOT NULL DEFAULT '[]',
  evidence_claim_ids_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'confirmed', 'rejected', 'stale'))
);
CREATE INDEX analyst_signals_status ON analyst_signals(status, created_at);

CREATE TABLE analyst_hypotheses (
  id INTEGER PRIMARY KEY,
  created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER)),
  updated_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER)),
  session_label TEXT NOT NULL,
  statement_vi TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'supported', 'refuted', 'inconclusive')),
  verification_notes_vi TEXT NOT NULL DEFAULT '',
  supporting_claim_ids_json TEXT NOT NULL DEFAULT '[]',
  contradicting_claim_ids_json TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX analyst_hypotheses_status ON analyst_hypotheses(status, updated_at);

CREATE TRIGGER analyst_signals_no_delete BEFORE DELETE ON analyst_signals
BEGIN
  SELECT RAISE(ABORT, 'analyst_signals is append-only');
END;

CREATE TRIGGER analyst_signals_keep_origin BEFORE UPDATE OF created_at, session_label ON analyst_signals
BEGIN
  SELECT RAISE(ABORT, 'created_at and session_label cannot change');
END;

CREATE TRIGGER analyst_hypotheses_no_delete BEFORE DELETE ON analyst_hypotheses
BEGIN
  SELECT RAISE(ABORT, 'analyst_hypotheses is append-only');
END;

CREATE TRIGGER analyst_hypotheses_keep_origin BEFORE UPDATE OF created_at, session_label ON analyst_hypotheses
BEGIN
  SELECT RAISE(ABORT, 'created_at and session_label cannot change');
END;

-- Verification questions of strong stories that no analyst signal refers to yet.
CREATE VIEW v_open_questions AS
SELECT s.id AS story_id, s.label_text, s.headline_vi, s.score, s.status, q.value AS question
FROM stories s, json_each(s.questions_json) q
WHERE s.alive = 1 AND s.score >= 60
  AND NOT EXISTS (SELECT 1 FROM analyst_signals g, json_each(g.story_ids_json) j WHERE j.value = s.id);
