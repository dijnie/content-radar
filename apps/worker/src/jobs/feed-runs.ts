import type { EditorialEntry, FeedKind } from "@radar/core";
import { searchable } from "../cluster/score-step";
import type { Env } from "../env";
import type { FeedMessage } from "../llm/messages";
import { buildFeedEntries, type FeedBuildContext } from "../feeds/build-feed";

export const FEEDS: readonly FeedKind[] = ["news", "hands-on", "deep-dives"];
export const isFeed = (value: unknown): value is FeedKind => typeof value === "string" && FEEDS.includes(value as FeedKind);
type FeedEnv = Pick<Env, "DB" | "POLL_QUEUE">;
interface Run { id: number; feed: FeedKind; crawl_id: number; started_at: number }
const LEASE_SECONDS = 900;

export async function startFeedRun(env: FeedEnv, feed: FeedKind, crawlId: number | null, now: number, trigger: "manual" | "schedule"): Promise<{ id: number; created: boolean } | null> {
  const crawl = await env.DB.prepare(`SELECT id FROM crawl_runs WHERE status IN ('ok', 'partial')
    ${crawlId === null ? "" : "AND id = ?"} ORDER BY id DESC LIMIT 1`).bind(...(crawlId === null ? [] : [crawlId])).first<{ id: number }>();
  if (!crawl) return null;
  const run = await env.DB.prepare(`INSERT INTO feed_runs (feed, crawl_id, started_at, trigger) VALUES (?, ?, ?, ?)
    ON CONFLICT DO NOTHING RETURNING id`).bind(feed, crawl.id, now, trigger).first<{ id: number }>();
  if (!run) {
    const active = await env.DB.prepare("SELECT id FROM feed_runs WHERE feed = ? AND status IN ('queued', 'running')").bind(feed).first<{ id: number }>();
    return active ? { id: active.id, created: false } : null;
  }
  // Queue failure leaves a recoverable queued job. The accepted intent is never lost.
  try { await env.POLL_QUEUE.send({ kind: "build-feed", runId: run.id } satisfies FeedMessage); }
  catch { console.error(JSON.stringify({ event: "feed_enqueue_deferred", runId: run.id })); }
  return { id: run.id, created: true };
}

export async function scheduleFeeds(env: FeedEnv, now: number): Promise<void> {
  const schedules = await env.DB.prepare("SELECT feed, interval_minutes FROM feed_schedules WHERE enabled = 1 AND next_run_at <= ? ORDER BY feed").bind(now).all<{ feed: FeedKind; interval_minutes: number }>();
  for (const schedule of schedules.results) {
    const started = await startFeedRun(env, schedule.feed, null, now, "schedule");
    if (started) await env.DB.prepare("UPDATE feed_schedules SET next_run_at = ? WHERE feed = ? AND next_run_at <= ?").bind(now + schedule.interval_minutes * 60, schedule.feed, now).run();
  }
}

export async function recoverFeedRuns(env: FeedEnv, now: number): Promise<void> {
  await env.DB.prepare("UPDATE feed_runs SET status = 'failed', finished_at = ?, error = 'build retries exhausted' WHERE status IN ('queued', 'running') AND lease_until <= ? AND attempts >= 6").bind(now, now).run();
  const rows = await env.DB.prepare("SELECT id FROM feed_runs WHERE status IN ('queued', 'running') AND lease_until <= ? ORDER BY id").bind(now).all<{ id: number }>();
  for (const run of rows.results) await env.POLL_QUEUE.send({ kind: "build-feed", runId: run.id } satisfies FeedMessage);
}

export interface FeedBuildDeps {
  now?: number;
  build?: (context: FeedBuildContext) => AsyncGenerator<EditorialEntry[]>;
  beforePublish?: () => Promise<void>;
}

/** Staging can span batches; the publication pointer and success state change in one fenced transaction. */
export async function runFeedBuild(env: Pick<Env, "DB">, runId: number, deps: FeedBuildDeps = {}): Promise<void> {
  const db = env.DB;
  const now = deps.now ?? Math.floor(Date.now() / 1000);
  const startedMs = Date.now();
  const clock = () => now + Math.floor((Date.now() - startedMs) / 1000);
  const token = crypto.randomUUID();
  const run = await db.prepare(`UPDATE feed_runs SET status = 'running', token = ?, lease_until = ?, attempts = attempts + 1
    WHERE id = ? AND status IN ('queued', 'running') AND lease_until <= ? RETURNING id, feed, crawl_id, started_at`)
    .bind(token, now + LEASE_SECONDS, runId, now).first<Run>();
  if (!run) return;
  const fence = "EXISTS (SELECT 1 FROM feed_runs WHERE id = ? AND token = ? AND status = 'running' AND lease_until > ?)";
  try {
    await db.prepare(`DELETE FROM feed_entries WHERE run_id = ? AND ${fence}`).bind(runId, runId, token, clock()).run();
    const metadata: Record<string, unknown> = {};
    const context: FeedBuildContext = { db, feed: run.feed, crawlId: run.crawl_id, now, metadata };
    for await (const entries of (deps.build ?? buildFeedEntries)(context)) {
      const renewed = await db.prepare("UPDATE feed_runs SET lease_until = ? WHERE id = ? AND token = ? AND status = 'running' AND lease_until > ? RETURNING id")
        .bind(clock() + LEASE_SECONDS, runId, token, clock()).first();
      if (!renewed) return;
      for (let offset = 0; offset < entries.length; offset += 30) {
        await db.batch(entries.slice(offset, offset + 30).map((entry) => db.prepare(`INSERT INTO feed_entries
          (run_id, entry_key, category, pillar, score, published_at, search_text, payload_json)
          SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE ${fence}
          ON CONFLICT(run_id, entry_key) DO UPDATE SET category = excluded.category, pillar = excluded.pillar,
            score = excluded.score, published_at = excluded.published_at, search_text = excluded.search_text, payload_json = excluded.payload_json`)
          .bind(runId, entry.key, entry.category, entry.pillar, entry.score, entry.publishedAt,
            searchable([entry.title, entry.summary, ...entry.findings]), JSON.stringify(entry), runId, token, clock())));
      }
    }
    await deps.beforePublish?.();
    const at = clock();
    await db.batch([
      db.prepare(`INSERT INTO feed_publications (feed, run_id) SELECT ?, ? WHERE ${fence}
        ON CONFLICT(feed) DO UPDATE SET run_id = excluded.run_id WHERE excluded.run_id > feed_publications.run_id`).bind(run.feed, runId, runId, token, at),
      db.prepare(`UPDATE feed_runs SET status = 'done', finished_at = ?, lease_until = 0,
        item_count = (SELECT COUNT(*) FROM feed_entries WHERE run_id = ?), metadata_json = ?
        WHERE id = ? AND token = ? AND status = 'running' AND lease_until > ?`)
        .bind(at, runId, JSON.stringify(metadata), runId, token, at),
    ]);
  } catch (error) {
    await db.prepare("UPDATE feed_runs SET status = 'failed', finished_at = ?, lease_until = 0, error = ? WHERE id = ? AND token = ? AND status = 'running'")
      .bind(clock(), error instanceof Error ? error.message.slice(0, 300) : "build failed", runId, token).run();
    throw error;
  }
}
