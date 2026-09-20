import type { CoreParams } from "../params.ts";
import { normalizeRows, row, type VectorMatrix } from "../vector/cosine.ts";

export interface CosineEdge {
  claimA: number;
  claimB: number;
  cosine: number;
}

/**
 * Exact top-k cosine neighbours for each new claim against every vector in the
 * window. Two claims of the same item are never linked. This is the invariant
 * part of an edge and the only part that gets stored.
 */
export function cosineNeighbours(
  newClaimIds: readonly number[],
  window: VectorMatrix,
  itemIdByClaim: ReadonlyMap<number, number>,
  params: Pick<CoreParams, "cosineFloor" | "maxNeighboursPerClaim">,
): CosineEdge[] {
  const unit = normalizeRows(window);
  const indexOf = new Map(unit.ids.map((id, index) => [id, index]));
  const edges = new Map<string, CosineEdge>();

  for (const claimId of [...newClaimIds].sort((a, b) => a - b)) {
    const index = indexOf.get(claimId);
    if (index === undefined) continue;
    const self = row(unit, index);
    const item = itemIdByClaim.get(claimId);
    const candidates: { id: number; cosine: number }[] = [];
    for (let other = 0; other < unit.ids.length; other++) {
      const otherId = unit.ids[other]!;
      if (otherId === claimId || (item !== undefined && itemIdByClaim.get(otherId) === item)) continue;
      const target = row(unit, other);
      let dot = 0;
      for (let d = 0; d < unit.dims; d++) dot += self[d]! * target[d]!;
      if (dot >= params.cosineFloor) candidates.push({ id: otherId, cosine: Math.min(1, dot) });
    }
    // Ties break on id so the result never depends on input order.
    candidates.sort((a, b) => b.cosine - a.cosine || a.id - b.id);
    for (const candidate of candidates.slice(0, params.maxNeighboursPerClaim)) {
      const [claimA, claimB] = claimId < candidate.id ? [claimId, candidate.id] : [candidate.id, claimId];
      edges.set(`${claimA}:${claimB}`, { claimA, claimB, cosine: candidate.cosine });
    }
  }
  return [...edges.values()].sort((a, b) => a.claimA - b.claimA || a.claimB - b.claimB);
}
