import { entitySignature, entityStats, leidenClusterer, promoteSingletons, velocityZ, weightedEdges, type AuthorBaseline, type VectorMatrix } from "@radar/core";
import { ENGAGEMENT_SQL, LATEST_SNAPSHOT_SQL } from "../db/engagement";
import { getSetting } from "../db/settings-repo";
import type { ClusterOutput, JobContext, WindowClaim } from "./job-context";
import { windowStart } from "./job-context";

export async function loadWindowClaims(ctx: JobContext): Promise<WindowClaim[]> {
  const { results } = await ctx.db
    .prepare("SELECT id, item_id, author_id, published_at, kind, has_numbers, first_hand, text_vi, topics_json, derived_from_claim_id FROM claims WHERE published_at >= ? ORDER BY id")
    .bind(windowStart(ctx))
    .all<{ id: number; item_id: number; author_id: number | null; published_at: number; kind: WindowClaim["kind"]; has_numbers: number; first_hand: number; text_vi: string; topics_json: string; derived_from_claim_id: number | null }>();
  return results.map((row) => ({
    id: row.id, itemId: row.item_id, authorId: row.author_id, publishedAt: row.published_at, kind: row.kind, hasNumbers: row.has_numbers === 1,
    firstHand: row.first_hand === 1, textVi: row.text_vi, topics: JSON.parse(row.topics_json) as string[], derivedFromClaimId: row.derived_from_claim_id,
  }));
}

async function velocityByClaim(ctx: JobContext, claims: readonly WindowClaim[]): Promise<Map<number, number | null>> {
  const { results: latest } = await ctx.db
    .prepare(
      `SELECT i.id AS item_id, i.platform, i.author_id, i.published_at, ${ENGAGEMENT_SQL} AS engagement
       FROM items i JOIN item_metrics m ON m.item_id = i.id
       WHERE i.id IN (SELECT DISTINCT item_id FROM claims WHERE published_at >= ?)
         AND ${LATEST_SNAPSHOT_SQL}`,
    )
    .bind(windowStart(ctx))
    .all<{ item_id: number; platform: string; author_id: number | null; published_at: number; engagement: number }>();
  const { results: baselines } = await ctx.db.prepare("SELECT author_id, platform, median, mad, sample_size FROM author_baselines WHERE metric = 'engagement'").all<{ author_id: number; platform: string; median: number; mad: number; sample_size: number }>();
  const baselineOf = new Map(baselines.map((row) => [`${row.author_id}:${row.platform}`, { median: row.median, mad: row.mad, sampleSize: row.sample_size } satisfies AuthorBaseline]));

  const zByItem = new Map<number, number | null>();
  for (const row of latest) {
    const baseline = row.author_id === null ? null : (baselineOf.get(`${row.author_id}:${row.platform}`) ?? null);
    zByItem.set(row.item_id, velocityZ(row.engagement, (ctx.now - row.published_at) / 3600, baseline, ctx.params));
  }
  return new Map(claims.map((claim) => [claim.id, zByItem.get(claim.itemId) ?? null]));
}

/** Builds this run's weighted graph from stored cosine edges and the current entity resolution, then clusters it. */
export async function clusterStep(ctx: JobContext, vectors: VectorMatrix): Promise<ClusterOutput> {
  const since = windowStart(ctx);
  const claims = await loadWindowClaims(ctx);
  const inWindow = new Set(claims.map((claim) => claim.id));

  const entityIdsByClaim = new Map<number, number[]>(claims.map((claim) => [claim.id, []]));
  const { results: mentions } = await ctx.db
    .prepare("SELECT m.claim_id, m.entity_id FROM entity_mentions m JOIN claims c ON c.id = m.claim_id WHERE c.published_at >= ? AND m.entity_id IS NOT NULL")
    .bind(since)
    .all<{ claim_id: number; entity_id: number }>();
  for (const mention of mentions) entityIdsByClaim.get(mention.claim_id)?.push(mention.entity_id);

  const stopNames = (await getSetting<string[]>(ctx.db, "stop_entities")) ?? [];
  const stopEntityIds = new Set<number>();
  if (stopNames.length > 0) {
    const { results: aliases } = await ctx.db.prepare("SELECT alias_normalized, entity_id FROM entity_aliases").all<{ alias_normalized: string; entity_id: number }>();
    const stop = new Set(stopNames);
    for (const alias of aliases) if (stop.has(alias.alias_normalized)) stopEntityIds.add(alias.entity_id);
  }

  const { results: stored } = await ctx.db
    .prepare("SELECT e.claim_a, e.claim_b, e.cosine FROM claim_edges e JOIN claims a ON a.id = e.claim_a JOIN claims b ON b.id = e.claim_b WHERE a.published_at >= ?1 AND b.published_at >= ?1")
    .bind(since)
    .all<{ claim_a: number; claim_b: number; cosine: number }>();
  const edges = weightedEdges(
    claims.map((claim) => ({ id: claim.id, itemId: claim.itemId, publishedAt: claim.publishedAt })),
    stored.filter((edge) => inWindow.has(edge.claim_a) && inWindow.has(edge.claim_b)).map((edge) => ({ claimA: edge.claim_a, claimB: edge.claim_b, cosine: edge.cosine })),
    entityIdsByClaim, stopEntityIds, ctx.params,
  );

  const clustering = leidenClusterer.cluster(claims.map((claim) => claim.id), edges, ctx.params);
  const velocityZByClaim = await velocityByClaim(ctx, claims);
  const groups = [...clustering.communities, ...promoteSingletons(clustering.singletons, velocityZByClaim, ctx.params)].sort((a, b) => a[0]! - b[0]!);

  const { idf, hubs } = entityStats(entityIdsByClaim, ctx.params);
  const excluded = new Set([...stopEntityIds, ...hubs]);
  return {
    claims, entityIdsByClaim, idf, velocityZByClaim, vectors, edgeCount: edges.length, quality: clustering.quality,
    communities: groups.map((members, index) => ({ index, members, signature: entitySignature(members, entityIdsByClaim, idf, excluded) })),
  };
}
