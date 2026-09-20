import { median, medianAbsoluteDeviation } from "@radar/core";
import { chunkedBatch } from "../db/batch";
import { ENGAGEMENT_SQL, LATEST_SNAPSHOT_SQL } from "../db/engagement";

const POSTS_PER_BASELINE = 50;
const MATURE_AFTER_SECONDS = 24 * 3600;

/**
 * Each author's normal engagement per platform: median and MAD over their 50
 * most recent posts that are at least a day old. Backfilled posts count too,
 * since their numbers have long matured.
 */
export async function updateAuthorBaselines(db: D1Database, now: number): Promise<number> {
  const { results } = await db
    .prepare(
      `SELECT author_id, platform, engagement FROM (
         SELECT i.author_id, i.platform, ${ENGAGEMENT_SQL} AS engagement,
                ROW_NUMBER() OVER (PARTITION BY i.author_id, i.platform ORDER BY i.published_at DESC, i.id DESC) AS recency
         FROM items i JOIN item_metrics m ON m.item_id = i.id
         WHERE i.author_id IS NOT NULL AND i.kind != 'repost' AND i.published_at <= ? AND ${LATEST_SNAPSHOT_SQL}
       ) WHERE recency <= ? ORDER BY author_id, platform`,
    )
    .bind(now - MATURE_AFTER_SECONDS, POSTS_PER_BASELINE)
    .all<{ author_id: number; platform: string; engagement: number }>();

  const samples = new Map<string, number[]>();
  for (const row of results) {
    const key = `${row.author_id}:${row.platform}`;
    samples.set(key, [...(samples.get(key) ?? []), row.engagement]);
  }
  const upsert = db.prepare(
    `INSERT INTO author_baselines (author_id, platform, metric, median, mad, sample_size, updated_at) VALUES (?, ?, 'engagement', ?, ?, ?, ?)
     ON CONFLICT(author_id, platform, metric) DO UPDATE SET median = excluded.median, mad = excluded.mad, sample_size = excluded.sample_size, updated_at = excluded.updated_at`,
  );
  await chunkedBatch(db, [...samples].map(([key, values]) => {
    const [authorId, platform] = key.split(":") as [string, string];
    const centre = median(values);
    return upsert.bind(Number(authorId), platform, centre, medianAbsoluteDeviation(values, centre), values.length, now);
  }));
  return samples.size;
}
