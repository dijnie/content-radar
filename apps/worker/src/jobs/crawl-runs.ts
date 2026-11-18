import { listDueSources } from "../db/sources-repo";
import type { Env } from "../env";
import type { PollMessage } from "../llm/messages";

type CrawlEnv = Pick<Env, "DB" | "POLL_QUEUE">;
const LEASE_SECONDS = 15 * 60;

/** A single active crawl keeps manual runs and scheduler ticks from polling the same sources twice. */
export async function startCrawl(env: CrawlEnv, now: number, trigger: "manual" | "schedule"): Promise<{ id: number; created: boolean } | null> {
  const active = await env.DB.prepare("SELECT id FROM crawl_runs WHERE status = 'running'").first<{ id: number }>();
  if (active) return { id: active.id, created: false };
  const sources = trigger === "manual"
    ? (await env.DB.prepare("SELECT id FROM sources WHERE enabled = 1 ORDER BY priority, id").all<{ id: number }>()).results
    : await listDueSources(env.DB, now, 500);
  if (!sources.length) return null;
  const run = await env.DB.prepare("INSERT INTO crawl_runs (trigger, started_at) VALUES (?, ?) ON CONFLICT DO NOTHING RETURNING id").bind(trigger, now).first<{ id: number }>();
  if (!run) {
    const winner = await env.DB.prepare("SELECT id FROM crawl_runs WHERE status = 'running'").first<{ id: number }>();
    return winner ? { id: winner.id, created: false } : null;
  }
  // Membership is persisted before any message. Recovery also repairs a crash during dispatch.
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO crawl_sources (crawl_id, source_id)
      SELECT ?1, id FROM sources WHERE enabled = 1 AND EXISTS (SELECT 1 FROM crawl_runs WHERE id = ?1 AND status = 'running') ${trigger === "schedule" ? "AND next_poll_at <= ?" : ""}
      ORDER BY priority, next_poll_at ${trigger === "schedule" ? "LIMIT 500" : ""}`)
      .bind(...(trigger === "schedule" ? [run.id, now] : [run.id])),
    env.DB.prepare("UPDATE sources SET next_poll_at = ? WHERE id IN (SELECT source_id FROM crawl_sources WHERE crawl_id = ?)").bind(now + LEASE_SECONDS, run.id),
  ]);
  await enqueueCrawlSources(env, run.id, now);
  return { id: run.id, created: true };
}

export async function enqueueCrawlSources(env: CrawlEnv, crawlId: number, now: number): Promise<void> {
  const { results } = await env.DB.prepare("SELECT source_id FROM crawl_sources WHERE crawl_id = ? AND status IN ('queued', 'running') AND lease_until <= ? ORDER BY source_id").bind(crawlId, now).all<{ source_id: number }>();
  for (let offset = 0; offset < results.length; offset += 100) {
    await env.POLL_QUEUE.sendBatch(results.slice(offset, offset + 100).map(({ source_id }) => ({ body: { sourceId: source_id, crawlId } satisfies PollMessage })));
  }
}

export async function claimCrawlSource(db: D1Database, crawlId: number, sourceId: number, now: number): Promise<string | null> {
  const token = crypto.randomUUID();
  const row = await db.prepare(`UPDATE crawl_sources SET status = 'running', token = ?, lease_until = ?, attempts = attempts + 1
    WHERE crawl_id = ? AND source_id = ? AND status IN ('queued', 'running') AND lease_until <= ?
    AND EXISTS (SELECT 1 FROM crawl_runs WHERE id = ? AND status = 'running') RETURNING source_id`)
    .bind(token, now + LEASE_SECONDS, crawlId, sourceId, now, crawlId).first();
  return row ? token : null;
}

export async function finishCrawlSource(db: D1Database, crawlId: number, sourceId: number, token: string, now: number, itemsNew: number, error: string | null): Promise<void> {
  await db.prepare(`UPDATE crawl_sources SET status = ?, finished_at = ?, items_new = ?, error = ?, lease_until = 0
    WHERE crawl_id = ? AND source_id = ? AND token = ? AND status = 'running'`)
    .bind(error ? "failed" : "ok", now, itemsNew, error, crawlId, sourceId, token).run();
  await finishCrawl(db, crawlId, now);
}

export async function finishCrawl(db: D1Database, crawlId: number, now: number): Promise<void> {
  await db.prepare(`UPDATE crawl_runs SET finished_at = ?2, status = CASE
      WHEN NOT EXISTS (SELECT 1 FROM crawl_sources WHERE crawl_id = ?1 AND status = 'ok') THEN 'failed'
      WHEN EXISTS (SELECT 1 FROM crawl_sources WHERE crawl_id = ?1 AND status = 'failed') THEN 'partial' ELSE 'ok' END
    WHERE id = ?1 AND status = 'running' AND EXISTS (SELECT 1 FROM crawl_sources WHERE crawl_id = ?1)
      AND NOT EXISTS (SELECT 1 FROM crawl_sources WHERE crawl_id = ?1 AND status IN ('queued', 'running'))`)
    // Numbered parameters make the repeated identity explicit; time is the second parameter.
    .bind(crawlId, now).run();
}

export async function recoverCrawls(env: CrawlEnv, now: number): Promise<void> {
  const active = await env.DB.prepare("SELECT id, started_at FROM crawl_runs WHERE status = 'running'").first<{ id: number; started_at: number }>();
  if (!active) return;
  await env.DB.prepare(`UPDATE crawl_sources SET status = 'failed', error = 'poll retries exhausted', finished_at = ?
    WHERE crawl_id = ? AND status IN ('queued', 'running') AND attempts >= 6 AND lease_until <= ?`).bind(now, active.id, now).run();
  // If the process died before persisting the source list, retain a visible failed run.
  await env.DB.prepare(`UPDATE crawl_runs SET status = 'failed', finished_at = ? WHERE id = ? AND started_at <= ?
    AND NOT EXISTS (SELECT 1 FROM crawl_sources WHERE crawl_id = crawl_runs.id)`).bind(now, active.id, now - LEASE_SECONDS).run();
  await finishCrawl(env.DB, active.id, now);
  await enqueueCrawlSources(env, active.id, now);
}
