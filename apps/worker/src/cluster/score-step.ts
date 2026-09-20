import { centroid, cosine, countIndependentSources, fallbackHeadline, scoreStory, storyStatus, type Subscores } from "@radar/core";
import { chunkForParams, placeholders } from "../db/batch";
import type { ClusterOutput, JobContext } from "./job-context";
import type { LineageOutput } from "./lineage-step";

export interface ScoredStory {
  index: number;
  storyId: number;
  members: number[];
  membersHash: string;
  score: number;
  subscores: Subscores;
  status: "lead" | "ready";
  independentSources: number;
  hasCounter: boolean;
  labelEntityId: number | null;
  labelText: string | null;
  signature: number[];
  topics: string[];
  searchText: string;
  fallbackHeadline: string;
  firstClaimAt: number;
  lastClaimAt: number;
}

/** Lower-cased, accent-free text for the `LIKE` search on `stories.search_text`. */
export function searchable(parts: readonly string[]): string {
  return parts.join(" ").normalize("NFKD").replace(/\p{M}/gu, "").replace(/đ/gi, "d").toLowerCase().replace(/\s+/g, " ").trim().slice(0, 4000);
}

export async function scoreStep(ctx: JobContext, cluster: ClusterOutput, lineage: LineageOutput): Promise<ScoredStory[]> {
  const claimById = new Map(cluster.claims.map((claim) => [claim.id, claim]));
  const rowOf = new Map(cluster.vectors.ids.map((id, index) => [id, index]));
  const centroids = cluster.communities.map((community) =>
    centroid(community.members.flatMap((id) => { const row = rowOf.get(id); return row === undefined ? [] : [cluster.vectors.data.subarray(row * cluster.vectors.dims, (row + 1) * cluster.vectors.dims)]; }), cluster.vectors.dims),
  );

  // Roles are the LLM's judgement from an earlier synthesis; only `counter` feeds the score.
  const storyIds = [...lineage.storyIdByIndex.values()];
  const counters = new Set<string>();
  for (const chunk of chunkForParams(storyIds)) {
    const { results } = await ctx.db.prepare(`SELECT story_id, claim_id FROM story_claims WHERE role = 'counter' AND story_id IN (${placeholders(chunk.length)})`).bind(...chunk).all<{ story_id: number; claim_id: number }>();
    for (const row of results) counters.add(`${row.story_id}:${row.claim_id}`);
  }
  const labelIds = new Set<number>();
  const scored: ScoredStory[] = [];

  for (const community of cluster.communities) {
    const storyId = lineage.storyIdByIndex.get(community.index)!;
    const members = community.members.map((id) => claimById.get(id)!);
    let maxCosine = 0;
    for (let other = 0; other < centroids.length; other++) if (other !== community.index) maxCosine = Math.max(maxCosine, cosine(centroids[community.index]!, centroids[other]!));
    const zValues = community.members.map((id) => cluster.velocityZByClaim.get(id) ?? null).filter((z): z is number => z !== null);
    const lastClaimAt = Math.max(...members.map((claim) => claim.publishedAt));
    const independentSources = countIndependentSources(members.map((claim) => ({ id: claim.id, authorId: claim.authorId, derivedFromClaimId: claim.derivedFromClaimId })));
    const hasCounter = community.members.some((id) => counters.has(`${storyId}:${id}`));
    const { score, subscores } = scoreStory(
      { independentSources, maxVelocityZ: zValues.length ? Math.max(...zValues) : null, claims: members, hasCounter, maxCosineToOtherStories: maxCosine, hoursSinceLatestClaim: (ctx.now - lastClaimAt) / 3600 },
      ctx.params,
    );
    const labelEntityId = [...community.signature].sort((a, b) => (cluster.idf.get(b) ?? 0) - (cluster.idf.get(a) ?? 0) || a - b)[0] ?? null;
    if (labelEntityId !== null) labelIds.add(labelEntityId);
    scored.push({
      index: community.index, storyId, members: community.members, membersHash: lineage.membersHashByIndex.get(community.index)!, score, subscores,
      status: storyStatus(independentSources), independentSources, hasCounter, labelEntityId, labelText: null, signature: community.signature,
      topics: [...new Set(members.flatMap((claim) => claim.topics))].sort(), searchText: "", fallbackHeadline: fallbackHeadline(members) ?? "",
      firstClaimAt: Math.min(...members.map((claim) => claim.publishedAt)), lastClaimAt,
    });
  }

  const names = new Map<number, string>();
  for (const chunk of chunkForParams([...labelIds])) {
    const { results } = await ctx.db.prepare(`SELECT id, canonical_name FROM entities WHERE id IN (${placeholders(chunk.length)})`).bind(...chunk).all<{ id: number; canonical_name: string }>();
    for (const row of results) names.set(row.id, row.canonical_name);
  }
  for (const story of scored) {
    story.labelText = story.labelEntityId === null ? null : (names.get(story.labelEntityId) ?? null);
    story.searchText = searchable([story.labelText ?? "", story.fallbackHeadline, ...story.members.map((id) => claimById.get(id)!.textVi)]);
  }
  return scored;
}
