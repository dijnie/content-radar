import { chunkedBatch } from "../db/batch";
import { CLUSTER_LEASE, releaseLeaseStatement } from "./job-lease";
import type { ClusterOutput, JobContext } from "./job-context";
import type { LineageOutput } from "./lineage-step";
import type { ScoredStory } from "./score-step";

/**
 * Publishes a run in two phases.
 *
 * Staging writes this run's stories, retirements and lineage events in chunks.
 * Chunks are separate transactions, which is fine because nothing reads these
 * rows: they carry the run id and the run is not `done`.
 *
 * Publishing is ONE `db.batch`, which D1 runs as a single transaction. A handful
 * of set-based statements copy the staged rows into `stories` and
 * `story_claims`, retire absorbed and dead stories, flip the run to `done` and
 * release the lease. Either all of it becomes visible or none of it does, so a
 * job that dies anywhere leaves readers on the previous finished run, with every
 * story id and every user state intact.
 */
export async function finalizeStep(ctx: JobContext, cluster: ClusterOutput, lineage: LineageOutput, stories: readonly ScoredStory[], beforePublish?: () => void | Promise<void>): Promise<void> {
  const { db, runId, now } = ctx;
  const staging: D1PreparedStatement[] = [];

  const event = db.prepare("INSERT INTO lineage_events (run_id, type, story_id, related_story_id, jaccard, at) VALUES (?, ?, ?, ?, ?, ?)");
  for (const assignment of lineage.assignments) {
    const related = assignment.relatedStoryIds.length > 0 ? assignment.relatedStoryIds : [null];
    for (const relatedId of related) staging.push(event.bind(runId, assignment.event, assignment.storyId, relatedId, assignment.jaccard, now));
  }
  for (const storyId of lineage.deaths) staging.push(event.bind(runId, "death", storyId, null, null, now));

  const stage = db.prepare(
    `INSERT INTO run_stories (run_id, story_id, label_entity_id, label_text, fallback_headline, status, score, subscores_json, independent_sources,
       has_counter, topics_json, search_text, entity_signature_json, members_hash, first_claim_at, last_claim_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(run_id, story_id) DO NOTHING`,
  );
  for (const story of stories) {
    staging.push(
      stage.bind(
        runId, story.storyId, story.labelEntityId, story.labelText, story.fallbackHeadline, story.status, story.score, JSON.stringify(story.subscores),
        story.independentSources, story.hasCounter ? 1 : 0, JSON.stringify(story.topics), story.searchText, JSON.stringify(story.signature),
        story.membersHash, story.firstClaimAt, story.lastClaimAt,
      ),
    );
  }
  const retire = db.prepare("INSERT INTO run_retirements (run_id, story_id, heir_story_id) VALUES (?, ?, ?) ON CONFLICT(run_id, story_id) DO NOTHING");
  for (const merged of lineage.mergedAway) staging.push(retire.bind(runId, merged.storyId, lineage.storyIdByIndex.get(merged.intoIndex)!));
  for (const storyId of lineage.deaths) staging.push(retire.bind(runId, storyId, null));
  await chunkedBatch(db, staging);

  await beforePublish?.();

  const members = "run_members rm JOIN run_communities rc ON rc.run_id = rm.run_id AND rc.community_idx = rm.community_idx";
  await db.batch([
    // A story keeps the headline the LLM wrote; only a story without one takes the deterministic fallback.
    // Attempts count per membership, so they reset when the membership changes.
    db
      .prepare(
        `UPDATE stories SET
           label_entity_id = rs.label_entity_id, label_text = rs.label_text,
           headline_vi = CASE WHEN stories.headline_source = 'llm' AND stories.headline_vi != '' THEN stories.headline_vi ELSE rs.fallback_headline END,
           status = rs.status, score = rs.score, subscores_json = rs.subscores_json, independent_sources = rs.independent_sources,
           has_counter = rs.has_counter, topics_json = rs.topics_json, search_text = rs.search_text, entity_signature_json = rs.entity_signature_json,
           synthesis_attempts = CASE WHEN stories.members_hash = rs.members_hash THEN stories.synthesis_attempts ELSE 0 END,
           members_hash = rs.members_hash, first_seen_at = MIN(stories.first_seen_at, rs.first_claim_at), last_claim_at = rs.last_claim_at,
           alive = 1, died_at = NULL
         FROM run_stories rs WHERE rs.run_id = ?1 AND rs.story_id = stories.id`,
      )
      .bind(runId),
    // Membership is a projection of this run: newcomers join, leavers are switched off, stayers keep their role.
    db
      .prepare(
        `INSERT INTO story_claims (story_id, claim_id, active, added_run_id)
         SELECT rc.story_id, rm.claim_id, 1, ?1 FROM ${members} WHERE rm.run_id = ?1
         ON CONFLICT(story_id, claim_id) DO UPDATE SET active = 1, removed_run_id = NULL`,
      )
      .bind(runId),
    db
      .prepare(
        `UPDATE story_claims SET active = 0, removed_run_id = ?1
         WHERE active = 1 AND story_id IN (SELECT story_id FROM run_stories WHERE run_id = ?1)
           AND NOT EXISTS (SELECT 1 FROM ${members} WHERE rm.run_id = ?1 AND rc.story_id = story_claims.story_id AND rm.claim_id = story_claims.claim_id)`,
      )
      .bind(runId),
    // A choice the user made on an absorbed story moves to the heir, unless the heir has its own.
    db
      .prepare(
        `UPDATE stories SET user_state = old.user_state, user_state_at = old.user_state_at
         FROM run_retirements rt JOIN stories old ON old.id = rt.story_id
         WHERE rt.run_id = ?1 AND rt.heir_story_id = stories.id AND stories.user_state = 'inbox' AND old.user_state != 'inbox'`,
      )
      .bind(runId),
    db.prepare("UPDATE stories SET alive = 0, died_at = ?2 WHERE alive = 1 AND id IN (SELECT story_id FROM run_retirements WHERE run_id = ?1)").bind(runId, now),
    db.prepare("UPDATE story_claims SET active = 0, removed_run_id = ?1 WHERE active = 1 AND story_id IN (SELECT story_id FROM run_retirements WHERE run_id = ?1)").bind(runId),
    db
      .prepare("UPDATE cluster_runs SET status = 'done', stage = 'done', finished_at = ?, heartbeat_at = ?, node_count = ?, edge_count = ?, community_count = ?, quality = ? WHERE id = ? AND status = 'running'")
      .bind(now, now, cluster.claims.length, cluster.edgeCount, cluster.communities.length, cluster.quality, runId),
    releaseLeaseStatement(db, CLUSTER_LEASE, ctx.holder),
  ]);
}
