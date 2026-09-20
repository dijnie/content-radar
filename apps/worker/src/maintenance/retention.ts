import { DEFAULT_PARAMS } from "@radar/core";

const DAY = 86_400;
const LOG_DAYS = 14;
const DERIVED_DAYS_AFTER_WINDOW = 30;
const ORPHAN_GRACE_DAYS = 1;

/**
 * Trims derived data and logs. Items, claims, stories, lineage events and the
 * daily series are kept forever, and nothing a user acted on is ever deleted.
 */
export async function applyRetention(db: D1Database, now: number, windowDays: number = DEFAULT_PARAMS.windowDays): Promise<void> {
  const logCutoff = now - LOG_DAYS * DAY;
  const derivedCutoff = now - (windowDays + DERIVED_DAYS_AFTER_WINDOW) * DAY;
  const orphanCutoff = now - ORPHAN_GRACE_DAYS * DAY;

  await db.batch([
    db.prepare("DELETE FROM run_members WHERE run_id IN (SELECT id FROM cluster_runs WHERE started_at < ?)").bind(logCutoff),
    db.prepare("DELETE FROM poll_log WHERE at < ?").bind(logCutoff),
    db.prepare("DELETE FROM llm_calls WHERE at < ?").bind(logCutoff),
    db.prepare("DELETE FROM claim_embeddings WHERE claim_id IN (SELECT id FROM claims WHERE published_at < ?)").bind(derivedCutoff),
    db.prepare("DELETE FROM claim_edges WHERE claim_a IN (SELECT id FROM claims WHERE published_at < ?1) OR claim_b IN (SELECT id FROM claims WHERE published_at < ?1)").bind(derivedCutoff),
    // After two weeks one engagement snapshot per item per day is enough: the last of each day.
    db
      .prepare(
        `DELETE FROM item_metrics WHERE captured_at < ?1 AND captured_at != (
           SELECT MAX(later.captured_at) FROM item_metrics later
           WHERE later.item_id = item_metrics.item_id AND DATE(later.captured_at, 'unixepoch') = DATE(item_metrics.captured_at, 'unixepoch'))`,
      )
      .bind(logCutoff),
  ]);

  // Snapshots of failed runs are invisible; once old they go, and with them the
  // placeholder stories those runs reserved but never published.
  await db.batch([
    db.prepare("DELETE FROM run_members WHERE run_id IN (SELECT id FROM cluster_runs WHERE status = 'failed' AND started_at < ?)").bind(orphanCutoff),
    db.prepare("DELETE FROM run_communities WHERE run_id IN (SELECT id FROM cluster_runs WHERE status = 'failed' AND started_at < ?)").bind(orphanCutoff),
    db
      .prepare(
        `DELETE FROM stories WHERE alive = 0 AND died_at IS NULL AND first_seen_at < ?
           AND id NOT IN (SELECT story_id FROM run_communities)
           AND id NOT IN (SELECT story_id FROM user_actions)
           AND id NOT IN (SELECT story_id FROM story_claims)
           AND id NOT IN (SELECT story_id FROM lineage_events)
           AND id NOT IN (SELECT related_story_id FROM lineage_events WHERE related_story_id IS NOT NULL)`,
      )
      .bind(orphanCutoff),
  ]);
}
