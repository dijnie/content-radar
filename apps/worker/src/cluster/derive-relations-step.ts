import { deriveRelations, type RelationClaim, type RelationItem } from "@radar/core";
import { chunkedBatch } from "../db/batch";
import type { JobContext } from "./job-context";
import { windowStart } from "./job-context";

/**
 * Decides, once per claim, whether it relays another claim. The whole window is
 * the context, but only claims not examined before are written, so an earlier
 * decision never flips when later claims arrive.
 */
export async function deriveRelationsStep(ctx: JobContext): Promise<number> {
  const since = windowStart(ctx);
  const { results: claims } = await ctx.db
    .prepare("SELECT id, item_id, kind, first_hand, published_at, derivation_reason FROM claims WHERE published_at >= ? ORDER BY id")
    .bind(since)
    .all<{ id: number; item_id: number; kind: RelationClaim["kind"]; first_hand: number; published_at: number; derivation_reason: string | null }>();
  const pending = new Set(claims.filter((claim) => claim.derivation_reason === null).map((claim) => claim.id));
  if (pending.size === 0) return 0;

  // An item's primary link is the one URL it is about: exactly one outgoing link.
  const { results: items } = await ctx.db
    .prepare(
      `SELECT i.id, i.platform, i.external_id, i.kind, i.parent_external_id,
              (SELECT CASE WHEN COUNT(*) = 1 THEN MIN(l.canonical_url) END FROM item_links l WHERE l.item_id = i.id) AS primary_link
       FROM items i WHERE i.id IN (SELECT DISTINCT item_id FROM claims WHERE published_at >= ?)`,
    )
    .bind(since)
    .all<{ id: number; platform: string; external_id: string; kind: string; parent_external_id: string | null; primary_link: string | null }>();

  const relations = deriveRelations(
    claims.map((claim): RelationClaim => ({ id: claim.id, itemId: claim.item_id, kind: claim.kind, firstHand: claim.first_hand === 1, publishedAt: claim.published_at })),
    items.map((item): RelationItem => ({ id: item.id, platform: item.platform, externalId: item.external_id, kind: item.kind, parentExternalId: item.parent_external_id, primaryLink: item.primary_link })),
  ).filter((relation) => pending.has(relation.claimId));

  const update = ctx.db.prepare("UPDATE claims SET derived_from_claim_id = ?, derivation_reason = ? WHERE id = ? AND derivation_reason IS NULL");
  await chunkedBatch(ctx.db, relations.map((relation) => update.bind(relation.derivedFromClaimId, relation.reason, relation.claimId)));
  return relations.length;
}
