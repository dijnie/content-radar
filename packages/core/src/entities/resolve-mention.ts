import type { CoreParams } from "../params.ts";

export interface NearestEntity {
  entityId: number;
  /** Normalized canonical name of the candidate. */
  normalizedName: string;
  cosine: number;
}

export type MentionDecision =
  | { action: "alias"; entityId: number; addAlias: boolean }
  | { action: "new" }
  | { action: "adjudicate"; candidateEntityId: number; similarity: number };

const VERSION_TOKEN = /(?:^|[\s\-])(v?\d+(?:\.\d+)*[a-z]?)(?=$|[\s\-])/g;

/** Version-like tokens of a normalized name, e.g. "deepseek-v4.1 flash" -> ["4.1"]. */
export function versionTokens(normalized: string): string[] {
  return [...normalized.matchAll(VERSION_TOKEN)].map((match) => match[1]!.replace(/^v/, ""));
}

/**
 * Decision ladder, cheapest first: exact alias, then embedding similarity, and
 * the LLM only for the ambiguous band. Names that differ in a version marker
 * are never merged automatically, however similar they look, because "V4" and
 * "V4.1" are different things whose relation (`version_of`) is worth keeping.
 */
export function resolveMention(
  normalized: string,
  aliasEntityId: number | null,
  nearest: NearestEntity | null,
  params: Pick<CoreParams, "aliasAutoAccept" | "aliasAutoReject">,
): MentionDecision {
  if (aliasEntityId !== null) return { action: "alias", entityId: aliasEntityId, addAlias: false };
  if (!nearest || nearest.cosine < params.aliasAutoReject) return { action: "new" };

  const versionsDiffer = versionTokens(normalized).join("|") !== versionTokens(nearest.normalizedName).join("|");
  if (versionsDiffer) return { action: "adjudicate", candidateEntityId: nearest.entityId, similarity: nearest.cosine };
  if (nearest.cosine >= params.aliasAutoAccept) return { action: "alias", entityId: nearest.entityId, addAlias: true };
  return { action: "adjudicate", candidateEntityId: nearest.entityId, similarity: nearest.cosine };
}
