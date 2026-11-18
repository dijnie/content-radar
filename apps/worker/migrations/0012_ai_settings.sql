-- Only the D1 owner can retrieve the initial Settings access token.
CREATE TABLE ai_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  owner_token TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  chat_endpoint TEXT NOT NULL DEFAULT '',
  chat_model TEXT,
  chat_key TEXT NOT NULL DEFAULT '',
  embedding_endpoint TEXT NOT NULL DEFAULT '',
  embedding_model TEXT NOT NULL DEFAULT 'text-embedding-3-small',
  embedding_key TEXT NOT NULL DEFAULT ''
);
INSERT INTO ai_settings (id, owner_token) VALUES (1, lower(hex(randomblob(32))));
