export async function seedAi(db: D1Database, overrides: { endpoint?: string; model?: string | null; apiKey?: string; embeddingModel?: string } = {}) {
  await db.prepare(`UPDATE ai_settings SET enabled = 1, chat_endpoint = ?, chat_model = ?, chat_key = ?,
    embedding_endpoint = '', embedding_model = ?, embedding_key = '' WHERE id = 1`)
    .bind(overrides.endpoint ?? "https://llm.example/v1", overrides.model ?? null, overrides.apiKey ?? "test-key",
      overrides.embeddingModel ?? "text-embedding-3-small").run();
}
