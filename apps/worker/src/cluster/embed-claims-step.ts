import type { JobContext } from "./job-context";
import { windowStart } from "./job-context";
import { putVectors } from "./vector-store";

const CLAIMS_PER_RUN = 2000;

/** Embeds `text_en` of window claims that have no vector yet. A second run finds nothing left to do. */
export async function embedClaimsStep(ctx: JobContext): Promise<number> {
  const { results } = await ctx.db
    .prepare(
      `SELECT c.id, c.text_en FROM claims c LEFT JOIN claim_embeddings e ON e.claim_id = c.id
       WHERE e.claim_id IS NULL AND c.published_at >= ? ORDER BY c.id LIMIT ?`,
    )
    .bind(windowStart(ctx), CLAIMS_PER_RUN)
    .all<{ id: number; text_en: string }>();
  if (results.length === 0) return 0;
  const vectors = await ctx.embed(results.map((row) => row.text_en));
  await putVectors(ctx.db, "claim_embeddings", results.map((row, index) => ({ id: row.id, vector: vectors[index]! })), ctx.now);
  return results.length;
}
