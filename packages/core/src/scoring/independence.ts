export interface SourceClaim {
  id: number;
  /** Canonical author after handle linking; null when the author is unknown. */
  authorId: number | null;
  derivedFromClaimId: number | null;
}

/**
 * Number of independent sources behind a set of claims: distinct pairs of
 * (canonical author, derivation root). Six people relaying one announcement
 * share a root and count once; one person on two platforms shares an author
 * and counts once; a rebuttal with its own root counts as a new source.
 */
export function countIndependentSources(claims: readonly SourceClaim[]): number {
  const byId = new Map(claims.map((claim) => [claim.id, claim]));
  const rootOf = (claim: SourceClaim): SourceClaim => {
    const seen = new Set<number>();
    let current = claim;
    // Follow the chain inside this set only, and stop on a cycle.
    while (current.derivedFromClaimId !== null && !seen.has(current.id)) {
      seen.add(current.id);
      const parent = byId.get(current.derivedFromClaimId);
      if (!parent) break;
      current = parent;
    }
    return current;
  };

  const roots = new Map<number, SourceClaim>();
  for (const claim of claims) {
    const root = rootOf(claim);
    roots.set(root.id, root);
  }
  // Several roots by one author are still one source.
  const sources = new Set<string>();
  for (const root of roots.values()) sources.add(root.authorId === null ? `claim:${root.id}` : `author:${root.authorId}`);
  return sources.size;
}
