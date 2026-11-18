export type ClaimKind = "measurement" | "experience" | "announcement" | "report" | "opinion";

export interface ClaimRow {
  id: number;
  item_id: number;
  author_id: number | null;
  kind: ClaimKind;
  text_vi: string;
  text_en: string;
  quote: string;
  has_numbers: number;
  first_hand: number;
  topics_json: string;
  published_at: number;
  content_hash: string;
  derived_from_claim_id: number | null;
  derivation_reason: string | null;
  model: string;
  prompt_version: number;
  llm_call_id: number | null;
  created_at: number;
}

export interface ClaimInput {
  itemId: number;
  authorId: number | null;
  kind: ClaimKind;
  textVi: string;
  textEn: string;
  quote: string;
  hasNumbers: boolean;
  firstHand: boolean;
  topics: string[];
  publishedAt: number;
  /** sha256 of the normalized quote. */
  contentHash: string;
  model: string;
  promptVersion: number;
  llmCallId: number | null;
  createdAt: number;
}

export interface MentionInput {
  surface: string;
  normalized: string;
  surfaceType: string | null;
}

/**
 * A replayed extraction hits the (item_id, content_hash) key and is skipped.
 * Only that conflict is tolerated: `INSERT OR IGNORE` would also swallow CHECK
 * violations and silently drop a malformed claim.
 */
export function insertClaim(db: D1Database, claim: ClaimInput, itemHash: string | null = null): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO claims (item_id, author_id, kind, text_vi, text_en, quote, has_numbers, first_hand,
         topics_json, published_at, content_hash, model, prompt_version, llm_call_id, created_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15
       WHERE ?16 IS NULL OR EXISTS (SELECT 1 FROM items WHERE id = ?1 AND content_hash = ?16)
       ON CONFLICT(item_id, content_hash) DO NOTHING`,
    )
    .bind(
      claim.itemId, claim.authorId, claim.kind, claim.textVi, claim.textEn, claim.quote, claim.hasNumbers ? 1 : 0,
      claim.firstHand ? 1 : 0, JSON.stringify(claim.topics), claim.publishedAt, claim.contentHash, claim.model,
      claim.promptVersion, claim.llmCallId, claim.createdAt, itemHash,
    );
}

/**
 * Attaches mentions to the claim identified by its natural key, and only when
 * that claim has none yet, so a replayed batch cannot duplicate mentions.
 */
export function insertMentions(db: D1Database, itemId: number, contentHash: string, mentions: readonly MentionInput[], itemHash: string | null = null): D1PreparedStatement[] {
  return mentions.map((mention, index) =>
    db
      .prepare(
        `INSERT INTO entity_mentions (claim_id, surface, normalized, surface_type)
         SELECT c.id, ?3, ?4, ?5 FROM claims c
         WHERE c.item_id = ?1 AND c.content_hash = ?2
           AND (?7 IS NULL OR EXISTS (SELECT 1 FROM items WHERE id = ?1 AND content_hash = ?7))
           AND (SELECT COUNT(*) FROM entity_mentions m WHERE m.claim_id = c.id) = ?6`,
      )
      .bind(itemId, contentHash, mention.surface, mention.normalized, mention.surfaceType, index, itemHash),
  );
}

export async function listClaimsForItem(db: D1Database, itemId: number): Promise<ClaimRow[]> {
  const { results } = await db.prepare("SELECT * FROM claims WHERE item_id = ? ORDER BY id").bind(itemId).all<ClaimRow>();
  return results;
}
