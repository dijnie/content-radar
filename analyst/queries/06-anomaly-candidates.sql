-- Candidates from three deterministic rules. Each one is a lead to verify, not a finding.
SELECT rule, subject_kind, subject_id, label, url, strength, at
FROM v_anomaly_candidates ORDER BY at DESC LIMIT 40;
