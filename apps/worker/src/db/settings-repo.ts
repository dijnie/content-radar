export async function getSetting<T>(db: D1Database, key: string): Promise<T | undefined> {
  const row = await db.prepare("SELECT value_json FROM settings WHERE key = ?").bind(key).first<{ value_json: string }>();
  return row ? (JSON.parse(row.value_json) as T) : undefined;
}

export async function getAllSettings(db: D1Database): Promise<Record<string, unknown>> {
  const { results } = await db.prepare("SELECT key, value_json FROM settings").all<{ key: string; value_json: string }>();
  return Object.fromEntries(results.map((row) => [row.key, JSON.parse(row.value_json) as unknown]));
}

export async function setSetting(db: D1Database, key: string, value: unknown): Promise<void> {
  await db
    .prepare("INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json")
    .bind(key, JSON.stringify(value))
    .run();
}
