-- Record a signal. Parameters: :session_label, :kind (anomaly | trend | shift), :title, :summary_vi,
-- :confidence (0..1), :story_ids_json, :entity_ids_json, :evidence_claim_ids_json (JSON arrays of ids).
INSERT INTO analyst_signals (session_label, kind, title, summary_vi, confidence, story_ids_json, entity_ids_json, evidence_claim_ids_json)
VALUES (:session_label, :kind, :title, :summary_vi, :confidence, :story_ids_json, :entity_ids_json, :evidence_claim_ids_json)
RETURNING id, created_at;
