import type { Platform } from "@radar/core";

export type SourceType = Platform;

export interface SourceRow {
  id: number;
  type: SourceType;
  key: string;
  label: string;
  topic_hint: string | null;
  author_key: string | null;
  priority: number;
  poll_interval_min: number;
  always_pass: number;
  enabled: number;
  next_poll_at: number;
  cursor_json: string | null;
}

export interface SourceHealthRow {
  source_id: number;
  last_ok_at: number | null;
  last_error_at: number | null;
  last_error: string | null;
  consecutive_failures: number;
  items_last_poll: number;
}

export interface PollLogEntry {
  sourceId: number;
  at: number;
  status: "ok" | "error";
  httpStatus?: number | null;
  itemsNew?: number;
  durationMs?: number;
  error?: string | null;
}

export async function listDueSources(db: D1Database, now: number, limit: number): Promise<SourceRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM sources WHERE enabled = 1 AND next_poll_at <= ? ORDER BY priority, next_poll_at LIMIT ?")
    .bind(now, limit)
    .all<SourceRow>();
  return results;
}

export function getSource(db: D1Database, id: number): Promise<SourceRow | null> {
  return db.prepare("SELECT * FROM sources WHERE id = ?").bind(id).first<SourceRow>();
}

export function getSourceHealth(db: D1Database, sourceId: number): Promise<SourceHealthRow | null> {
  return db.prepare("SELECT * FROM source_health WHERE source_id = ?").bind(sourceId).first<SourceHealthRow>();
}

export interface CrawlLease { id: number; token: string }

// Check ownership in the write itself so a concurrent Stop or lease takeover wins.
function pollOwnership(sourceId: number, crawl?: CrawlLease) {
  return crawl
    ? { sql: "EXISTS (SELECT 1 FROM crawl_sources WHERE crawl_id = ? AND source_id = ? AND token = ? AND status = 'running')", args: [crawl.id, sourceId, crawl.token] }
    : { sql: "1", args: [] };
}

export function scheduleNextPoll(db: D1Database, sourceId: number, nextPollAt: number, cursorJson?: string | null, crawl?: CrawlLease): D1PreparedStatement {
  const owner = pollOwnership(sourceId, crawl);
  return cursorJson === undefined
    ? db.prepare(`UPDATE sources SET next_poll_at = ? WHERE id = ? AND ${owner.sql}`).bind(nextPollAt, sourceId, ...owner.args)
    : db.prepare(`UPDATE sources SET next_poll_at = ?, cursor_json = ? WHERE id = ? AND ${owner.sql}`).bind(nextPollAt, cursorJson, sourceId, ...owner.args);
}

export function recordPollOk(db: D1Database, sourceId: number, at: number, itemsNew: number, crawl?: CrawlLease): D1PreparedStatement {
  const owner = pollOwnership(sourceId, crawl);
  return db
    .prepare(
      `INSERT INTO source_health (source_id, last_ok_at, consecutive_failures, items_last_poll) SELECT ?1, ?2, 0, ?3 WHERE ${owner.sql}
       ON CONFLICT(source_id) DO UPDATE SET last_ok_at = ?2, consecutive_failures = 0, items_last_poll = ?3`,
    )
    .bind(sourceId, at, itemsNew, ...owner.args);
}

export function recordPollError(db: D1Database, sourceId: number, at: number, error: string, crawl?: CrawlLease): D1PreparedStatement {
  const owner = pollOwnership(sourceId, crawl);
  return db
    .prepare(
      `INSERT INTO source_health (source_id, last_error_at, last_error, consecutive_failures, items_last_poll) SELECT ?1, ?2, ?3, 1, 0 WHERE ${owner.sql}
       ON CONFLICT(source_id) DO UPDATE SET last_error_at = ?2, last_error = ?3,
         consecutive_failures = consecutive_failures + 1, items_last_poll = 0`,
    )
    .bind(sourceId, at, error, ...owner.args);
}

export function insertPollLog(db: D1Database, entry: PollLogEntry, crawl?: CrawlLease): D1PreparedStatement {
  const owner = pollOwnership(entry.sourceId, crawl);
  return db
    .prepare(`INSERT INTO poll_log (source_id, at, status, http_status, items_new, duration_ms, error) SELECT ?, ?, ?, ?, ?, ?, ? WHERE ${owner.sql}`)
    .bind(entry.sourceId, entry.at, entry.status, entry.httpStatus ?? null, entry.itemsNew ?? 0, entry.durationMs ?? 0, entry.error ?? null, ...owner.args);
}
