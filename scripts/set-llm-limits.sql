-- Owner-approved application caps for the paid DeepSeek API: 100 requests/day, 5/minute.
-- Pacific calendar day; token usage determines actual cost. These are not provider quotas.
-- Run from apps/worker after migration 0009:
--   npx wrangler d1 execute content-radar --remote --file ../../scripts/set-llm-limits.sql
-- Verify with SELECT model, rpm, rpd, enabled FROM llm_models ORDER BY priority;
-- Never put API keys here. A 429 temporarily parks the model without changing these caps.
UPDATE llm_models SET rpm = 5, rpd = 100 WHERE model = 'deepseek-flash';
