-- What earlier sessions left open. Read this before forming new conclusions.
SELECT 'signal' AS record, id, created_at, session_label, kind AS kind_or_status, status, title AS title, summary_vi, evidence_claim_ids_json AS claim_ids_json
FROM analyst_signals WHERE status = 'open'
UNION ALL
SELECT 'hypothesis', id, created_at, session_label, status, status, statement_vi, verification_notes_vi, supporting_claim_ids_json
FROM analyst_hypotheses WHERE status IN ('proposed', 'inconclusive')
ORDER BY created_at DESC LIMIT 50;
