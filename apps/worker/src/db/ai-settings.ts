export interface AiSettings {
  revision: number;
  enabled: number;
  chat_endpoint: string;
  chat_model: string | null;
  chat_key: string;
  embedding_endpoint: string;
  embedding_model: string;
  embedding_key: string;
}

export async function getAiSettings(db: D1Database): Promise<AiSettings> {
  const row = await db.prepare(`SELECT revision, enabled, chat_endpoint, chat_model, chat_key,
    embedding_endpoint, embedding_model, embedding_key FROM ai_settings WHERE id = 1`).first<AiSettings>();
  if (!row) throw new Error("ai_settings_missing");
  return row;
}

export function selectedChatModel(settings: AiSettings): string | null {
  return settings.enabled && settings.chat_endpoint && settings.chat_key ? settings.chat_model : "";
}

export function embeddingProvider(settings: AiSettings) {
  return {
    endpoint: settings.embedding_endpoint || settings.chat_endpoint,
    apiKey: settings.embedding_endpoint ? settings.embedding_key : settings.chat_key,
    model: settings.embedding_model,
  };
}
