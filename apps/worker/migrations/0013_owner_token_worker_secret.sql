-- Settings access is controlled by the OWNER_TOKEN Worker secret.
ALTER TABLE ai_settings DROP COLUMN owner_token;
