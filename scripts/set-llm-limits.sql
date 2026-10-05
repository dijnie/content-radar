-- Owner-approved application caps for the configured AI model: 100 requests/day, 5/minute.
-- Pacific calendar day; token usage determines actual cost. These are not provider quotas.
-- Replace your-model-id below with LLM_MODEL after its first use creates the D1 row.
-- Run from apps/worker:
--   npx wrangler d1 execute DB --remote --file ../../scripts/set-llm-limits.sql
-- Verify with SELECT model, rpm, rpd, enabled FROM llm_models ORDER BY priority;
-- Never put API keys here. A 429 temporarily parks the model without changing these caps.
UPDATE llm_models SET rpm = 5, rpd = 100 WHERE model = 'your-model-id';
