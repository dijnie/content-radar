import { cosineNeighbours, type VectorMatrix } from "@radar/core";
import { chunkedBatch } from "../db/batch";
import { upsertClaimEdge } from "../db/graph-repo";
import type { JobContext } from "./job-context";
import { windowStart } from "./job-context";
import { loadClaimVectors } from "./vector-store";

/**
 * Stores the cosine neighbours of claims embedded since the last finished run.
 * "Since the last finished run" rather than "in this run" matters: if an
 * earlier run died after embedding, its claims still get their neighbours here.
 */
export async function cosineEdgesStep(ctx: JobContext): Promise<{ vectors: VectorMatrix; newEdges: number }> {
  const since = windowStart(ctx);
  const vectors = await loadClaimVectors(ctx.db, since, ctx.embeddingModel);
  const { results: fresh } = await ctx.db
    .prepare("SELECT e.claim_id AS id FROM claim_embeddings e JOIN claims c ON c.id = e.claim_id WHERE c.published_at >= ? AND e.created_at >= ?")
    .bind(since, ctx.lastDoneRunStartedAt)
    .all<{ id: number }>();
  if (fresh.length === 0) return { vectors, newEdges: 0 };

  const { results: owners } = await ctx.db.prepare("SELECT id, item_id FROM claims WHERE published_at >= ?").bind(since).all<{ id: number; item_id: number }>();
  const edges = cosineNeighbours(fresh.map((row) => row.id), vectors, new Map(owners.map((row) => [row.id, row.item_id])), ctx.params);
  await chunkedBatch(ctx.db, edges.map((edge) => upsertClaimEdge(ctx.db, edge, ctx.now)));
  return { vectors, newEdges: edges.length };
}
