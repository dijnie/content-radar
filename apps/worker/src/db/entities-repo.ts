export type EntityType = "org" | "person" | "product" | "model" | "paper" | "repo" | "concept" | "other";
export type AliasSource = "manual" | "embedding" | "llm";

export interface EntityRow {
  id: number;
  canonical_name: string;
  type: EntityType;
  parent_entity_id: number | null;
  provisional: number;
  created_at: number;
}

export async function findEntityIdByAlias(db: D1Database, aliasNormalized: string): Promise<number | null> {
  const row = await db.prepare("SELECT entity_id FROM entity_aliases WHERE alias_normalized = ?").bind(aliasNormalized).first<{ entity_id: number }>();
  return row?.entity_id ?? null;
}

export async function createEntity(
  db: D1Database,
  input: { canonicalName: string; type: EntityType; provisional?: boolean; createdAt: number },
): Promise<number> {
  const row = await db
    .prepare("INSERT INTO entities (canonical_name, type, provisional, created_at) VALUES (?, ?, ?, ?) RETURNING id")
    .bind(input.canonicalName, input.type, input.provisional ? 1 : 0, input.createdAt)
    .first<{ id: number }>();
  if (!row) throw new Error(`could not create entity ${input.canonicalName}`);
  return row.id;
}

/** An alias already owned by another entity keeps its owner. */
export function addAlias(db: D1Database, entityId: number, aliasNormalized: string, source: AliasSource, confidence = 1): D1PreparedStatement {
  return db
    .prepare("INSERT INTO entity_aliases (entity_id, alias_normalized, source, confidence) VALUES (?, ?, ?, ?) ON CONFLICT(alias_normalized) DO NOTHING")
    .bind(entityId, aliasNormalized, source, confidence);
}
