-- Preserve Gemini history while switching the active model to DeepSeek.
-- Owner-approved application caps; these are not provider quotas.
UPDATE llm_models SET enabled = 0 WHERE model LIKE 'gemini-%';
INSERT INTO llm_models (model, priority, rpm, rpd, enabled)
VALUES ('deepseek-flash', 1, 5, 100, 1)
ON CONFLICT(model) DO UPDATE SET enabled = 1, priority = 1, rpm = 5, rpd = 100;

-- The previous provider's circuit must not block calls to the new provider.
DELETE FROM settings WHERE key = 'llm_circuit';
