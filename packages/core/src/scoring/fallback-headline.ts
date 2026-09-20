export interface HeadlineClaim {
  id: number;
  textVi: string;
  hasNumbers: boolean;
  firstHand: boolean;
  publishedAt: number;
}

/**
 * Deterministic headline for a story the LLM has not summarised yet, so a card
 * never waits on synthesis quota: the most specific claim's Vietnamese sentence,
 * the earliest one on a tie.
 */
export function fallbackHeadline(claims: readonly HeadlineClaim[]): string | null {
  const specificity = (claim: HeadlineClaim) => Number(claim.hasNumbers) + Number(claim.firstHand);
  const best = [...claims].sort((a, b) => specificity(b) - specificity(a) || a.publishedAt - b.publishedAt || a.id - b.id)[0];
  return best?.textVi ?? null;
}

/** Claims below the minimum community size that still deserve a card: engagement far outside the author's norm. */
export function promoteSingletons(singletons: readonly number[], velocityZByClaim: ReadonlyMap<number, number | null>, params: { singletonMinVelocityZ: number }): number[][] {
  return singletons
    .filter((claimId) => (velocityZByClaim.get(claimId) ?? Number.NEGATIVE_INFINITY) >= params.singletonMinVelocityZ)
    .sort((a, b) => a - b)
    .map((claimId) => [claimId]);
}
