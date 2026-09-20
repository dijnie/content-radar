import { chunkedBatch } from "../db/batch";
import { CLUSTER_LEASE, releaseLeaseStatement } from "./job-lease";
import type { ClusterOutput, JobContext } from "./job-context";
import type { LineageOutput } from "./lineage-step";
import type { ScoredStory } from "./score-step";

/**
 * Publishes a run. Everything before this step is tagged with the run id and
 * invisible to readers. Here stories, memberships and lineage events are
 * written in chunks, and the very last statement flips the run to `done`. If
 * the job dies anywhere before that statement, the next run ignores this
 * snapshot and matches against the last finished one, so no story id, no user
 * state and no lineage is ever derived from a half-written run.
 */
export async function finalizeStep(ctx: JobContext, cluster: ClusterOutput, lineage: LineageOutput, stories: readonly ScoredStory[]): Promise<void> {
  const { db, runId, now } = ctx;
  const statements: D1PreparedStatement[] = [];

  const event = db.prepare("INSERT INTO lineage_events (run_id, type, story_id, related_story_id, jaccard, at) VALUES (?, ?, ?, ?, ?, ?)");
  for (const assignment of lineage.assignments) {
    const related = assignment.relatedStoryIds.length > 0 ? assignment.relatedStoryIds : [null];
    for (const relatedId of related) statements.push(event.bind(runId, assignment.event, assignment.storyId, relatedId, assignment.jaccard, now));
  }

  // A story keeps the headline the LLM wrote; only a story without one takes the deterministic fallback.
  const upsertStory = db.prepare(
    `UPDATE stories SET
       label_entity_id = ?2, label_text = ?3,
       headline_vi = CASE WHEN headline_source = 'llm' AND headline_vi != '' THEN headline_vi ELSE ?4 END,
       status = ?5, score = ?6, subscores_json = ?7, independent_sources = ?8, has_counter = ?9, topics_json = ?10,
       search_text = ?11, entity_signature_json = ?12,
       synthesis_attempts = CASE WHEN members_hash = ?13 THEN synthesis_attempts ELSE 0 END, members_hash = ?13,
       first_seen_at = MIN(first_seen_at, ?14), last_claim_at = ?15, alive = 1, died_at = NULL
     WHERE id = ?1`,
  );
  for (const story of stories) {
    statements.push(
      upsertStory.bind(
        story.storyId, story.labelEntityId, story.labelText, story.fallbackHeadline, story.status, story.score, JSON.stringify(story.subscores),
        story.independentSources, story.hasCounter ? 1 : 0, JSON.stringify(story.topics), story.searchText, JSON.stringify(story.signature),
        story.membersHash, story.firstClaimAt, story.lastClaimAt,
      ),
    );
  }

  // Membership is a projection of this run: newcomers are added, leavers are
  // switched off, and a claim that stays keeps the role it was given.
  const join = db.prepare(
    `INSERT INTO story_claims (story_id, claim_id, active, added_run_id) VALUES (?1, ?2, 1, ?3)
     ON CONFLICT(story_id, claim_id) DO UPDATE SET active = 1, removed_run_id = NULL`,
  );
  for (const story of stories) for (const claimId of story.members) statements.push(join.bind(story.storyId, claimId, runId));
  const leave = db.prepare(
    `UPDATE story_claims SET active = 0, removed_run_id = ?2
     WHERE story_id = ?1 AND active = 1 AND claim_id NOT IN (SELECT claim_id FROM run_members rm JOIN run_communities rc ON rc.run_id = rm.run_id AND rc.community_idx = rm.community_idx WHERE rm.run_id = ?2 AND rc.story_id = ?1)`,
  );
  for (const story of stories) statements.push(leave.bind(story.storyId, runId));

  // A story absorbed by a merge ends, and a choice the user made on it moves to the heir unless the heir has its own.
  const retire = db.prepare("UPDATE stories SET alive = 0, died_at = ? WHERE id = ? AND alive = 1");
  const inherit = db.prepare(
    `UPDATE stories SET user_state = (SELECT user_state FROM stories WHERE id = ?2), user_state_at = (SELECT user_state_at FROM stories WHERE id = ?2)
     WHERE id = ?1 AND user_state = 'inbox' AND (SELECT user_state FROM stories WHERE id = ?2) != 'inbox'`,
  );
  const deactivate = db.prepare("UPDATE story_claims SET active = 0, removed_run_id = ? WHERE story_id = ? AND active = 1");
  for (const merged of lineage.mergedAway) {
    const heir = lineage.storyIdByIndex.get(merged.intoIndex)!;
    statements.push(inherit.bind(heir, merged.storyId), retire.bind(now, merged.storyId), deactivate.bind(runId, merged.storyId));
  }
  for (const storyId of lineage.deaths) {
    statements.push(event.bind(runId, "death", storyId, null, null, now), retire.bind(now, storyId), deactivate.bind(runId, storyId));
  }

  await chunkedBatch(db, statements);
  // The flip and the lease release travel together, last.
  await db.batch([
    db
      .prepare("UPDATE cluster_runs SET status = 'done', stage = 'done', finished_at = ?, heartbeat_at = ?, node_count = ?, edge_count = ?, community_count = ?, quality = ? WHERE id = ? AND status = 'running'")
      .bind(now, now, cluster.claims.length, cluster.edgeCount, cluster.communities.length, cluster.quality, runId),
    releaseLeaseStatement(db, CLUSTER_LEASE, ctx.holder),
  ]);
}
