-- Real Gemini free-tier limits, read by the owner from https://aistudio.google.com/rate-limit
-- Fill in the numbers, then run:
--   cd apps/worker && npx wrangler d1 execute content-radar --remote --file ../../scripts/set-llm-limits.sql
-- While a value is NULL the safe defaults from config/settings.json apply (5 RPM, 100 RPD).
-- This file holds limits only. Never put a key in it.

UPDATE llm_models SET rpm = NULL, rpd = NULL, tpm = NULL WHERE model = 'gemini-3.8-flash';
UPDATE llm_models SET rpm = NULL, rpd = NULL, tpm = NULL WHERE model = 'gemini-3.7-flash';
UPDATE llm_models SET rpm = NULL, rpd = NULL, tpm = NULL WHERE model = 'gemini-3.6-flash';

SELECT model, priority, rpm, rpd, tpm, enabled, exhausted_until FROM llm_models ORDER BY priority;
