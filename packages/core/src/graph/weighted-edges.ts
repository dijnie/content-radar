import type { CoreParams } from "../params.ts";
import type { CosineEdge } from "./cosine-neighbours.ts";
import { entityStats } from "./entity-idf.ts";

export interface ClaimNode {
  id: number;
  itemId: number;
  publishedAt: number;
}

export interface WeightedEdge {
  claimA: number;
  claimB: number;
  weight: number;
}

/** Shared-entity candidates per entity are capped so one busy entity cannot produce a quadratic blow-up. */
const MAX_CLAIMS_PER_ENTITY_PAIRING = 60;

/**
 * Edges for one run. Candidates are the stored cosine edges plus pairs sharing a
 * meaningful entity. The entity part is computed here, from the current entity
 * resolution and this window's IDF, so nothing about it is ever frozen in storage.
 */
export function weightedEdges(
  claims: readonly ClaimNode[],
  cosineEdges: readonly CosineEdge[],
  entityIdsByClaim: ReadonlyMap<number, readonly number[]>,
  stopEntityIds: ReadonlySet<number>,
  params: Pick<CoreParams, "wCos" | "wEnt" | "minEdgeWeight" | "windowDays" | "hubEntityShare">,
): WeightedEdge[] {
  const byId = new Map(claims.map((claim) => [claim.id, claim]));
  const inWindow = new Map([...entityIdsByClaim].filter(([claimId]) => byId.has(claimId)));
  const { idf, hubs } = entityStats(inWindow, params);
  const meaningful = (claimId: number): number[] => [...new Set(inWindow.get(claimId) ?? [])].filter((id) => !stopEntityIds.has(id) && !hubs.has(id));
  const entitiesOf = new Map(claims.map((claim) => [claim.id, meaningful(claim.id)]));

  const key = (a: number, b: number) => (a < b ? `${a}:${b}` : `${b}:${a}`);
  const cosineOf = new Map<string, number>();
  for (const edge of cosineEdges) if (byId.has(edge.claimA) && byId.has(edge.claimB)) cosineOf.set(key(edge.claimA, edge.claimB), edge.cosine);

  const candidates = new Set(cosineOf.keys());
  const claimsByEntity = new Map<number, number[]>();
  for (const claim of [...claims].sort((a, b) => a.id - b.id)) {
    for (const entityId of entitiesOf.get(claim.id)!) {
      const list = claimsByEntity.get(entityId) ?? [];
      list.push(claim.id);
      claimsByEntity.set(entityId, list);
    }
  }
  for (const claimIds of claimsByEntity.values()) {
    const capped = claimIds.slice(0, MAX_CLAIMS_PER_ENTITY_PAIRING);
    for (let i = 0; i < capped.length; i++) for (let j = i + 1; j < capped.length; j++) candidates.add(key(capped[i]!, capped[j]!));
  }

  const maxGapSeconds = params.windowDays * 86_400;
  const edges: WeightedEdge[] = [];
  for (const candidate of candidates) {
    const [claimA, claimB] = candidate.split(":").map(Number) as [number, number];
    const a = byId.get(claimA)!;
    const b = byId.get(claimB)!;
    if (a.itemId === b.itemId || Math.abs(a.publishedAt - b.publishedAt) > maxGapSeconds) continue;

    // IDF-weighted Jaccard: sharing a rare entity counts, sharing a common one barely does.
    const setB = new Set(entitiesOf.get(claimB)!);
    let shared = 0;
    let union = 0;
    for (const entityId of entitiesOf.get(claimA)!) {
      const value = idf.get(entityId) ?? 0;
      union += value;
      if (setB.delete(entityId)) shared += value;
    }
    for (const entityId of setB) union += idf.get(entityId) ?? 0;
    const overlap = union === 0 ? 0 : shared / union;

    const weight = params.wCos * Math.max(0, cosineOf.get(candidate) ?? 0) + params.wEnt * overlap;
    if (weight >= params.minEdgeWeight) edges.push({ claimA, claimB, weight: Math.min(1, weight) });
  }
  return edges.sort((a, b) => a.claimA - b.claimA || a.claimB - b.claimB);
}
