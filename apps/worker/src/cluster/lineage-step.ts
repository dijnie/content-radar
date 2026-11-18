import { incompatibleBenchmarkGroup, matchCommunities, type DeadStory, type LineageResult, type PreviousCommunity } from "@radar/core";
import { chunkedBatch, chunkForParams, placeholders } from "../db/batch";
import { sha256Hex } from "../util/hash";
import type { ClusterOutput, JobContext } from "./job-context";

export interface LineageOutput extends LineageResult {
  /** Story of every community, by community index, after new ids were allocated. */
  storyIdByIndex: Map<number, number>;
  membersHashByIndex: Map<number, string>;
}

export function membersHash(members: readonly number[]): Promise<string> {
  return sha256Hex([...members].sort((a, b) => a - b).join(","));
}

/**
 * The latest sighting of every living story in a finished run, however old. The
 * lookback is a grace period before a story is declared dead, not a filter on
 * what counts as the past: after an outage longer than the lookback, stories
 * must still be matched or buried, never left alive next to a newborn copy.
 */
async function previousCommunities(ctx: JobContext): Promise<PreviousCommunity[]> {
  const { results } = await ctx.db
    .prepare(
      `SELECT rc.story_id, rc.run_id, rc.community_idx, r.finished_at
       FROM run_communities rc JOIN cluster_runs r ON r.id = rc.run_id JOIN stories s ON s.id = rc.story_id
       WHERE r.status = 'done' AND s.alive = 1
         AND rc.run_id = (SELECT MAX(rc2.run_id) FROM run_communities rc2 JOIN cluster_runs r2 ON r2.id = rc2.run_id
                          WHERE rc2.story_id = rc.story_id AND r2.status = 'done')
       ORDER BY rc.story_id`,
    )
    .all<{ story_id: number; run_id: number; community_idx: number; finished_at: number }>();

  // One batched read for all members instead of one query per story.
  const byCommunity = new Map<string, number[]>();
  const runIds = [...new Set(results.map((row) => row.run_id))];
  for (const chunk of chunkForParams(runIds)) {
    const { results: members } = await ctx.db
      .prepare(`SELECT run_id, community_idx, claim_id FROM run_members WHERE run_id IN (${placeholders(chunk.length)})`)
      .bind(...chunk)
      .all<{ run_id: number; community_idx: number; claim_id: number }>();
    for (const member of members) {
      const key = `${member.run_id}:${member.community_idx}`;
      byCommunity.set(key, [...(byCommunity.get(key) ?? []), member.claim_id]);
    }
  }
  const previous: PreviousCommunity[] = results.map((row) => ({ storyId: row.story_id, members: byCommunity.get(`${row.run_id}:${row.community_idx}`) ?? [], lastSeenAt: row.finished_at }));
  return previous;
}

/**
 * Gives every community its story. New stories are inserted as invisible
 * placeholders (`alive = 0`) purely to obtain an id; they only become visible in
 * the finalize step, so a run that dies here leaves nothing a reader can see.
 */
export async function lineageStep(ctx: JobContext, cluster: ClusterOutput): Promise<LineageOutput> {
  const previous = await previousCommunities(ctx);
  const { results: dead } = await ctx.db
    .prepare("SELECT id, entity_signature_json, died_at FROM stories WHERE alive = 0 AND died_at IS NOT NULL AND died_at >= ?")
    .bind(ctx.now - ctx.params.reviveHorizonDays * 86_400)
    .all<{ id: number; entity_signature_json: string; died_at: number }>();
  const deadStories: DeadStory[] = dead.map((row) => ({ storyId: row.id, signature: JSON.parse(row.entity_signature_json) as number[], diedAt: row.died_at }));

  const byId = new Map(cluster.claims.map((claim) => [claim.id, claim]));
  for (const story of previous) {
    story.invalidated = incompatibleBenchmarkGroup(story.members.map((id) => byId.get(id)));
  }
  const lineage = matchCommunities(cluster.communities, previous, deadStories, new Set(byId.keys()), ctx.now, ctx.params);

  const storyIdByIndex = new Map<number, number>();
  const membersHashByIndex = new Map<number, string>();
  for (const assignment of lineage.assignments) {
    const community = cluster.communities[assignment.index]!;
    const hash = await membersHash(community.members);
    membersHashByIndex.set(assignment.index, hash);
    if (assignment.storyId === null) {
      const row = await ctx.db
        .prepare("INSERT INTO stories (headline_vi, first_seen_at, last_claim_at, members_hash, alive) VALUES ('', ?, ?, ?, 0) RETURNING id")
        .bind(ctx.now, ctx.now, hash)
        .first<{ id: number }>();
      assignment.storyId = row!.id;
    }
    storyIdByIndex.set(assignment.index, assignment.storyId);
  }

  // Snapshot rows carry the run id and stay invisible until the run is marked done.
  const community = ctx.db.prepare("INSERT INTO run_communities (run_id, community_idx, story_id, size, members_hash) VALUES (?, ?, ?, ?, ?) ON CONFLICT(run_id, community_idx) DO NOTHING");
  const member = ctx.db.prepare("INSERT INTO run_members (run_id, community_idx, claim_id) VALUES (?, ?, ?) ON CONFLICT(run_id, community_idx, claim_id) DO NOTHING");
  await chunkedBatch(ctx.db, cluster.communities.map((draft) => community.bind(ctx.runId, draft.index, storyIdByIndex.get(draft.index)!, draft.members.length, membersHashByIndex.get(draft.index)!)));
  await chunkedBatch(ctx.db, cluster.communities.flatMap((draft) => draft.members.map((claimId) => member.bind(ctx.runId, draft.index, claimId))));
  return { ...lineage, storyIdByIndex, membersHashByIndex };
}
