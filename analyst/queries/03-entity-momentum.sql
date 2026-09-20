-- Which entities are accelerating? Parameter: :min_ratio (default in the runbook: 2).
SELECT entity_id, canonical_name, type, claims_7d, authors_7d, claims_prev_21d, weekly_baseline, ratio
FROM v_entity_momentum WHERE ratio >= :min_ratio ORDER BY ratio DESC, claims_7d DESC LIMIT 30;
