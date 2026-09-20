import type { CoreParams } from "../params.ts";

export interface EntityStats {
  /** Smoothed inverse document frequency, scaled to (0, 1]. */
  idf: ReadonlyMap<number, number>;
  /** Entities too common in this window to say anything about a story. */
  hubs: ReadonlySet<number>;
}

/** IDF of every entity over the claims in the window. An entity in more than `hubEntityShare` of the claims is a hub. */
export function entityStats(entityIdsByClaim: ReadonlyMap<number, readonly number[]>, params: Pick<CoreParams, "hubEntityShare">): EntityStats {
  const claimCount = entityIdsByClaim.size;
  const documentFrequency = new Map<number, number>();
  for (const entityIds of entityIdsByClaim.values()) {
    for (const entityId of new Set(entityIds)) documentFrequency.set(entityId, (documentFrequency.get(entityId) ?? 0) + 1);
  }
  const maxIdf = Math.log(1 + claimCount);
  const idf = new Map<number, number>();
  const hubs = new Set<number>();
  for (const [entityId, frequency] of documentFrequency) {
    idf.set(entityId, maxIdf === 0 ? 0 : Math.log(1 + claimCount / frequency) / maxIdf);
    // A share only means something once the window holds enough claims.
    if (claimCount >= 20 && frequency / claimCount > params.hubEntityShare) hubs.add(entityId);
  }
  return { idf, hubs };
}
