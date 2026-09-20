export interface RelationClaim {
  id: number;
  itemId: number;
  kind: "measurement" | "experience" | "announcement" | "report" | "opinion";
  firstHand: boolean;
  publishedAt: number;
}

export interface RelationItem {
  id: number;
  platform: string;
  externalId: string;
  kind: string;
  parentExternalId: string | null;
  /** The URL the item itself is about, when it has exactly one: an HN story's target, a post's single link. */
  primaryLink: string | null;
}

export type DerivationReason = "original" | "quote_or_repost" | "same_origin_url";

export interface Derivation {
  claimId: number;
  derivedFromClaimId: number | null;
  reason: DerivationReason;
}

/**
 * Decides which claims merely relay another claim. A relayed claim is not an
 * independent source, however many people relay it.
 *
 * - A claim in a quote or repost derives from the earliest claim of the quoted
 *   item, unless it is first-hand: someone who re-ran the benchmark while
 *   quoting the announcement is a new source.
 * - Reports and announcements whose items are about the same URL derive from
 *   the earliest claim about that URL. Only the item's primary link counts: two
 *   essays that both happen to cite a repository are not reports of one origin.
 * - A comment is an independent voice and never derives from its story.
 */
export function deriveRelations(claims: readonly RelationClaim[], items: readonly RelationItem[]): Derivation[] {
  const itemById = new Map(items.map((item) => [item.id, item]));
  const itemByExternal = new Map(items.map((item) => [`${item.platform}:${item.externalId}`, item]));
  const ordered = [...claims].sort((a, b) => a.publishedAt - b.publishedAt || a.id - b.id);
  const earliestOfItem = new Map<number, RelationClaim>();
  const earliestOfUrl = new Map<string, RelationClaim>();
  for (const claim of ordered) {
    if (!earliestOfItem.has(claim.itemId)) earliestOfItem.set(claim.itemId, claim);
    const url = itemById.get(claim.itemId)?.primaryLink;
    if (url && (claim.kind === "report" || claim.kind === "announcement") && !earliestOfUrl.has(url)) earliestOfUrl.set(url, claim);
  }

  return [...claims]
    .sort((a, b) => a.id - b.id)
    .map((claim): Derivation => {
      const original: Derivation = { claimId: claim.id, derivedFromClaimId: null, reason: "original" };
      const item = itemById.get(claim.itemId);
      if (!item || claim.firstHand) return original;

      if ((item.kind === "quote" || item.kind === "repost") && item.parentExternalId) {
        const parent = itemByExternal.get(`${item.platform}:${item.parentExternalId}`);
        const source = parent ? earliestOfItem.get(parent.id) : undefined;
        if (source && source.id !== claim.id) return { claimId: claim.id, derivedFromClaimId: source.id, reason: "quote_or_repost" };
      }
      if (item.primaryLink && (claim.kind === "report" || claim.kind === "announcement")) {
        const source = earliestOfUrl.get(item.primaryLink);
        if (source && source.id !== claim.id && source.itemId !== claim.itemId) return { claimId: claim.id, derivedFromClaimId: source.id, reason: "same_origin_url" };
      }
      return original;
    });
}
