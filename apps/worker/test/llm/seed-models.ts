/** Synthetic fallback IDs exercise generic chain behavior; production enables only deepseek-flash. */
export async function seedTestModels(db: D1Database): Promise<void> {
  await db.batch([
    db.prepare("UPDATE llm_models SET enabled = 0 WHERE model LIKE 'gemini-%'"),
    db.prepare("INSERT INTO llm_models (model, priority, rpm, rpd) VALUES ('deepseek-test-secondary', 2, 1000, 1000), ('deepseek-test-tertiary', 3, 1000, 1000) ON CONFLICT(model) DO NOTHING"),
  ]);
}
