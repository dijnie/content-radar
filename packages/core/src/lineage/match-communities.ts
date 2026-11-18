import type { CoreParams } from "../params.ts";
import { jaccard } from "./entity-signature.ts";

export interface CurrentCommunity {
  index: number;
  members: readonly number[];
  signature: readonly number[];
}

/** A living story as last seen in a finished run inside the lookback. */
export interface PreviousCommunity {
  storyId: number;
  members: readonly number[];
  /** Epoch seconds of the most recent finished run that contained the story. */
  lastSeenAt: number;
  /** The current evidence explicitly contradicts the old grouping. */
  invalidated?: boolean;
}

export interface DeadStory {
  storyId: number;
  signature: readonly number[];
  diedAt: number;
}

export type LineageEventType = "birth" | "continue" | "split" | "merge" | "revive";

export interface CommunityAssignment {
  index: number;
  /** Null means a new story; the caller allocates its id. */
  storyId: number | null;
  event: LineageEventType;
  relatedStoryIds: number[];
  jaccard: number | null;
}

export interface LineageResult {
  assignments: CommunityAssignment[];
  /** Stories absorbed by a merge: no longer alive, their members live on in `intoIndex`. */
  mergedAway: { storyId: number; intoIndex: number; jaccard: number }[];
  /** Stories with no successor whose evidence conflicts or whose last sighting is older than the lookback. */
  deaths: number[];
}

type LineageParams = Pick<CoreParams, "jaccardContinue" | "jaccardRelated" | "lookbackHours" | "reviveHorizonDays" | "reviveSignatureJaccard">;

/**
 * Carries story identity from earlier runs to the current communities.
 *
 * Earlier members are first narrowed to claims still inside the window. A
 * long-running story loses its oldest claims all at once when they age out;
 * compared on full membership that looks like the story vanishing, compared on
 * the surviving part it is plainly the same story.
 */
export function matchCommunities(
  current: readonly CurrentCommunity[],
  previous: readonly PreviousCommunity[],
  deadStories: readonly DeadStory[],
  windowClaimIds: ReadonlySet<number>,
  now: number,
  params: LineageParams,
): LineageResult {
  const currents = [...current].sort((a, b) => a.index - b.index);
  const previousInWindow = [...previous]
    .sort((a, b) => a.storyId - b.storyId)
    .map((story) => ({ ...story, members: story.members.filter((claimId) => windowClaimIds.has(claimId)) }));

  // Only pairs that share a member are ever compared.
  const storiesByClaim = new Map<number, number[]>();
  previousInWindow.forEach((story, position) => story.members.forEach((claimId) => storiesByClaim.set(claimId, [...(storiesByClaim.get(claimId) ?? []), position])));

  const similarity = new Map<string, number>();
  const bestPrevious = new Map<number, { position: number; value: number }>();
  const bestCurrent = new Map<number, { index: number; value: number }>();
  for (const community of currents) {
    const candidates = new Set(community.members.flatMap((claimId) => storiesByClaim.get(claimId) ?? []));
    for (const position of [...candidates].sort((a, b) => a - b)) {
      const value = jaccard(community.members, previousInWindow[position]!.members);
      if (value < params.jaccardRelated) continue;
      similarity.set(`${community.index}:${position}`, value);
      if (value > (bestPrevious.get(community.index)?.value ?? 0)) bestPrevious.set(community.index, { position, value });
      if (value > (bestCurrent.get(position)?.value ?? 0)) bestCurrent.set(position, { index: community.index, value });
    }
  }

  const children = new Map<number, CurrentCommunity[]>();
  const parents = new Map<number, number[]>();
  for (const community of currents) {
    const best = bestPrevious.get(community.index);
    if (best) children.set(best.position, [...(children.get(best.position) ?? []), community]);
  }
  for (const [position, best] of bestCurrent) parents.set(best.index, [...(parents.get(best.index) ?? []), position]);

  const claimed = new Set<number>();
  const claim = (storyId: number): number | null => (claimed.has(storyId) ? null : (claimed.add(storyId), storyId));
  const bySize = (a: { members: readonly number[] }, b: { members: readonly number[] }) => b.members.length - a.members.length;

  const assignments: CommunityAssignment[] = [];
  const mergedAway: LineageResult["mergedAway"] = [];
  const unmatched: CurrentCommunity[] = [];

  for (const community of currents) {
    const best = bestPrevious.get(community.index);
    const communityParents = (parents.get(community.index) ?? []).map((position) => previousInWindow[position]!);

    if (communityParents.length >= 2) {
      const ordered = [...communityParents].sort((a, b) => bySize(a, b) || a.storyId - b.storyId);
      const heir = ordered[0]!;
      const others = ordered.slice(1);
      const heirPosition = previousInWindow.indexOf(heir);
      for (const other of others) {
        claimed.add(other.storyId);
        mergedAway.push({ storyId: other.storyId, intoIndex: community.index, jaccard: similarity.get(`${community.index}:${previousInWindow.indexOf(other)}`)! });
      }
      assignments.push({ index: community.index, storyId: claim(heir.storyId), event: "merge", relatedStoryIds: others.map((story) => story.storyId), jaccard: similarity.get(`${community.index}:${heirPosition}`) ?? null });
      continue;
    }

    if (best) {
      const parent = previousInWindow[best.position]!;
      const siblings = children.get(best.position) ?? [];
      if (siblings.length >= 2) {
        const largest = [...siblings].sort((a, b) => bySize(a, b) || a.index - b.index)[0]!;
        assignments.push({ index: community.index, storyId: largest === community ? claim(parent.storyId) : null, event: "split", relatedStoryIds: [parent.storyId], jaccard: best.value });
        continue;
      }
      if (best.value >= params.jaccardContinue && bestCurrent.get(best.position)?.index === community.index) {
        const storyId = claim(parent.storyId);
        if (storyId !== null) {
          assignments.push({ index: community.index, storyId, event: "continue", relatedStoryIds: [], jaccard: best.value });
          continue;
        }
      }
    }
    unmatched.push(community);
  }

  // Nothing alive matches: a story that died recently may be flaring up again.
  const horizon = now - params.reviveHorizonDays * 86_400;
  const revivable = deadStories.filter((story) => story.diedAt >= horizon).sort((a, b) => a.storyId - b.storyId);
  for (const community of unmatched) {
    let revived: { storyId: number; value: number } | null = null;
    for (const story of revivable) {
      if (claimed.has(story.storyId)) continue;
      const value = jaccard(community.signature, story.signature);
      if (value >= params.reviveSignatureJaccard && value > (revived?.value ?? 0)) revived = { storyId: story.storyId, value };
    }
    const weakParent = bestPrevious.get(community.index);
    assignments.push(
      revived
        ? { index: community.index, storyId: claim(revived.storyId), event: "revive", relatedStoryIds: [], jaccard: revived.value }
        : { index: community.index, storyId: null, event: "birth", relatedStoryIds: weakParent ? [previousInWindow[weakParent.position]!.storyId] : [], jaccard: weakParent?.value ?? null },
    );
  }

  // A story missing from this run is only declared dead once the lookback has passed,
  // so a quiet hour does not cost it its identity.
  const deadline = now - params.lookbackHours * 3600;
  const deaths = previousInWindow.filter((story) => !claimed.has(story.storyId) && (story.invalidated || story.lastSeenAt < deadline)).map((story) => story.storyId);
  return { assignments: assignments.sort((a, b) => a.index - b.index), mergedAway, deaths };
}
