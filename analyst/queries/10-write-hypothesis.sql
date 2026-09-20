-- Record a hypothesis. Parameters: :session_label, :statement_vi, :status (proposed | supported | refuted | inconclusive),
-- :verification_notes_vi, :supporting_claim_ids_json, :contradicting_claim_ids_json.
INSERT INTO analyst_hypotheses (session_label, statement_vi, status, verification_notes_vi, supporting_claim_ids_json, contradicting_claim_ids_json)
VALUES (:session_label, :statement_vi, :status, :verification_notes_vi, :supporting_claim_ids_json, :contradicting_claim_ids_json)
RETURNING id, created_at;
