const SIGNATURE_SIZE = 8;

/**
 * The entities that characterise a community: highest total IDF across its
 * members, ties broken by id. It outlives the claims themselves, which is what
 * lets a story that died be recognised when it flares up again.
 */
export function entitySignature(members: readonly number[], entityIdsByClaim: ReadonlyMap<number, readonly number[]>, idf: ReadonlyMap<number, number>, excluded: ReadonlySet<number> = new Set()): number[] {
  const weight = new Map<number, number>();
  for (const claimId of members) {
    for (const entityId of new Set(entityIdsByClaim.get(claimId) ?? [])) {
      if (!excluded.has(entityId)) weight.set(entityId, (weight.get(entityId) ?? 0) + (idf.get(entityId) ?? 0));
    }
  }
  return [...weight.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, SIGNATURE_SIZE)
    .map(([entityId]) => entityId)
    .sort((a, b) => a - b);
}

export function jaccard(a: Iterable<number>, b: Iterable<number>): number {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size === 0 && setB.size === 0) return 0;
  let shared = 0;
  for (const value of setA) if (setB.has(value)) shared++;
  return shared / (setA.size + setB.size - shared);
}
