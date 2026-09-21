-- Real Gemini free-tier limits, read by the owner from https://aistudio.google.com/rate-limit
-- Fill in the numbers, then run:
--   cd apps/worker && npx wrangler d1 execute content-radar --remote --file ../../scripts/set-llm-limits.sql
-- On the remote database --file returns only a summary, so check the result afterwards with:
--   npx wrangler d1 execute content-radar --remote --command "SELECT model, rpm, rpd, tpm FROM llm_models ORDER BY priority"
-- Measured on 2026-09-21: a 429 from gemini-3.6-flash named the quota
-- GenerateRequestsPerDayPerProjectPerModel-FreeTier with a value of 20 requests per day.
-- The Worker also learns rpd and rpm by itself from every 429 it receives, so this file is
-- for setting limits ahead of time or correcting them by hand.
-- While a value is NULL the safe defaults from config/settings.json apply (5 RPM, 20 RPD).
-- This file holds limits only. Never put a key in it.

UPDATE llm_models SET rpm = NULL, rpd = NULL, tpm = NULL WHERE model = 'gemini-3.8-flash';
UPDATE llm_models SET rpm = NULL, rpd = NULL, tpm = NULL WHERE model = 'gemini-3.7-flash';
UPDATE llm_models SET rpm = NULL, rpd = NULL, tpm = NULL WHERE model = 'gemini-3.6-flash';

