import { ENGAGEMENT_SQL, LATEST_SNAPSHOT_SQL } from "../db/engagement";

const RECOMPUTE_DAYS = 16;

/**
 * Rebuilds the last 16 days of per-day series. The day comes from the claim's
 * publish time, not from when it was crawled, so a 15-day backfill fills in
 * history instead of piling onto today.
 */
export async function rebuildDailyAggregates(db: D1Database, now: number): Promise<void> {
  const since = now - RECOMPUTE_DAYS * 86_400;
  const sinceDay = new Date(since * 1000).toISOString().slice(0, 10);
  const today = new Date(now * 1000).toISOString().slice(0, 10);
  const engagement = `(SELECT ${ENGAGEMENT_SQL} FROM item_metrics m JOIN items i ON i.id = m.item_id WHERE i.id = c.item_id AND ${LATEST_SNAPSHOT_SQL})`;

  await db.batch([
    db.prepare("DELETE FROM story_daily WHERE day >= ?").bind(sinceDay),
    db
      .prepare(
        `INSERT INTO story_daily (story_id, day, claim_count, source_count, score, engagement)
         SELECT sc.story_id, DATE(c.published_at, 'unixepoch') AS day, COUNT(*), COUNT(DISTINCT c.author_id),
                CASE WHEN DATE(c.published_at, 'unixepoch') = ?2 THEN s.score END, SUM(COALESCE(${engagement}, 0))
         FROM story_claims sc JOIN claims c ON c.id = sc.claim_id JOIN stories s ON s.id = sc.story_id
         WHERE sc.active = 1 AND c.published_at >= ?1 GROUP BY sc.story_id, day`,
      )
      .bind(since, today),
    db.prepare("DELETE FROM entity_daily WHERE day >= ?").bind(sinceDay),
    db
      .prepare(
        `INSERT INTO entity_daily (entity_id, day, claim_count, author_count, engagement)
         SELECT em.entity_id, DATE(c.published_at, 'unixepoch') AS day, COUNT(DISTINCT c.id), COUNT(DISTINCT c.author_id), SUM(COALESCE(${engagement}, 0))
         FROM entity_mentions em JOIN claims c ON c.id = em.claim_id
         WHERE em.entity_id IS NOT NULL AND c.published_at >= ?1 GROUP BY em.entity_id, day`,
      )
      .bind(since),
  ]);
}
