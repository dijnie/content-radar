/**
 * One comparable number per metrics row `m`. Reposts and quotes spread a post
 * further than a like does, so they count double. Used for velocity, baselines
 * and daily aggregates, which must all agree on what "engagement" means.
 */
export const ENGAGEMENT_SQL = "(COALESCE(m.likes, 0) + 2 * COALESCE(m.reposts, 0) + COALESCE(m.replies, 0) + 2 * COALESCE(m.quotes, 0) + COALESCE(m.points, 0) + COALESCE(m.comments, 0))";

/** Restricts `item_metrics m` to the latest snapshot of item `i`. */
export const LATEST_SNAPSHOT_SQL = "m.captured_at = (SELECT MAX(captured_at) FROM item_metrics WHERE item_id = i.id)";
