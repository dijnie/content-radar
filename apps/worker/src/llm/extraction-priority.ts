import { resolveParams } from "@radar/core";
import { getSetting } from "../db/settings-repo";

/** A crawl owns ingestion only. AI work starts once its source batch has completed. */
export const CRAWL_FINISHED_SQL = `NOT EXISTS (SELECT 1 FROM crawl_sources cs JOIN crawl_runs cr ON cr.id = cs.crawl_id
  WHERE cs.source_id = items.source_id AND cr.status = 'running' AND items.fetched_at >= cr.started_at
  AND NOT EXISTS (SELECT 1 FROM crawl_items ci JOIN crawl_runs previous ON previous.id = ci.crawl_id
    WHERE ci.item_id = items.id AND previous.status IN ('ok', 'partial')))`;

/** Extraction priority follows the same publication window as story clustering. */
export async function extractionWindowStart(db: D1Database, now: number): Promise<number> {
  const params = resolveParams((await getSetting<Record<string, unknown>>(db, "core_overrides")) ?? {});
  return now - params.windowDays * 86_400;
}

/** Include recent work already in flight, so old queue messages cannot overtake it. */
export async function hasRecentQueuedItems(db: D1Database, since: number): Promise<boolean> {
  return (await db.prepare(`SELECT 1 FROM items WHERE status = 'queued' AND published_at >= ? AND ${CRAWL_FINISHED_SQL} LIMIT 1`).bind(since).first()) !== null;
}
