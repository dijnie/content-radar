import { checkOperatorPassword } from "./operator-password";
import { z } from "zod";
import type { FeedKind, JobRow, JobsResponse } from "@radar/core";
import { getSetting } from "../db/settings-repo";
import type { Env } from "../env";
import { startCrawl } from "../jobs/crawl-runs";
import { isFeed, startFeedRun } from "../jobs/feed-runs";
import { jsonError } from "./api-errors";

const paramsSchema = z.object({
  days: z.coerce.number().int().min(1).max(365).default(7),
  failures: z.enum(["0", "1"]).default("0"),
  page: z.coerce.number().int().min(1).max(100000).default(1),
});
const FILTERED_JOBS = `SELECT * FROM (
  SELECT id, 'crawl' AS kind, status, trigger, started_at AS startedAt, finished_at AS finishedAt,
    NULL AS crawlId, 0 AS entries, NULL AS error FROM crawl_runs
  UNION ALL
  SELECT id, feed, status, trigger, started_at, finished_at, crawl_id, item_count, error FROM feed_runs
) WHERE startedAt >= ? AND (? = 0 OR status IN ('partial', 'failed'))`;

const PAGE_SQL = `WITH page AS (
    ${FILTERED_JOBS} ORDER BY startedAt DESC, kind, id DESC LIMIT ? OFFSET ?
  ), source_counts AS (
    SELECT crawl_id, COUNT(*) AS sources, SUM(status IN ('ok', 'failed')) AS processed,
      SUM(status = 'running') AS running, SUM(status = 'failed') AS failures, SUM(items_new) AS itemsNew
    FROM crawl_sources WHERE crawl_id IN (SELECT id FROM page WHERE kind = 'crawl') GROUP BY crawl_id
  ), item_counts AS (
    SELECT crawl_id, SUM(json_extract(snapshot_json, '$.kind') != 'article') AS posts,
      SUM(json_extract(snapshot_json, '$.kind') = 'article') AS articles
    FROM crawl_items WHERE crawl_id IN (SELECT id FROM page WHERE kind = 'crawl') GROUP BY crawl_id
  )
  SELECT p.*, COALESCE(s.sources, 0) AS sources, COALESCE(s.processed, 0) AS sourcesProcessed,
    COALESCE(s.running, 0) AS sourcesRunning, COALESCE(s.failures, 0) AS failures, COALESCE(s.itemsNew, 0) AS itemsNew,
    COALESCE(i.posts, 0) AS posts, COALESCE(i.articles, 0) AS articles,
    CASE WHEN p.kind != 'crawl' AND p.status = 'running' THEN (SELECT COUNT(*) FROM feed_entries WHERE run_id = p.id)
      ELSE 0 END AS stagedEntries
  FROM page p
  LEFT JOIN source_counts s ON p.kind = 'crawl' AND s.crawl_id = p.id
  LEFT JOIN item_counts i ON p.kind = 'crawl' AND i.crawl_id = p.id
  ORDER BY p.startedAt DESC, p.kind, p.id DESC`;

export async function handleJobs(request: Request, env: Env, now = Math.floor(Date.now() / 1000)): Promise<Response> {
  const parsed = paramsSchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) return jsonError(400, "invalid_job_filters");
  const { days, failures, page } = parsed.data;
  const pageSize = 30;
  const bindings = [now - days * 86400, Number(failures)];
  const [list, total, schedules, timezone] = await Promise.all([
    env.DB.prepare(PAGE_SQL).bind(...bindings, pageSize, (page - 1) * pageSize).all<JobRow>(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM (${FILTERED_JOBS})`).bind(...bindings).first<{ n: number }>(),
    env.DB.prepare("SELECT feed, enabled, interval_minutes AS intervalMinutes, next_run_at AS nextRunAt FROM feed_schedules ORDER BY feed").all<{ feed: FeedKind; enabled: number; intervalMinutes: number; nextRunAt: number }>(),
    getSetting<string>(env.DB, "display_timezone"),
  ]);
  const body: JobsResponse = { crawls: list.results.filter((job) => job.kind === "crawl"), builds: list.results.filter((job) => job.kind !== "crawl"),
    schedules: schedules.results.map((schedule) => ({ ...schedule, enabled: Boolean(schedule.enabled) })), total: total?.n ?? 0, page, pageSize, timezone: timezone ?? "UTC" };
  return Response.json(body);
}

export async function handleJobDetail(env: Env, kind: string, id: number): Promise<Response> {
  if (kind === "crawl") {
    const run = await env.DB.prepare("SELECT * FROM crawl_runs WHERE id = ?").bind(id).first();
    if (!run) return jsonError(404, "job_not_found");
    const sources = await env.DB.prepare(`SELECT cs.source_id AS sourceId, s.label, s.type, cs.status, cs.items_new AS itemsNew, cs.finished_at AS finishedAt,
      cs.error, cs.attempts FROM crawl_sources cs JOIN sources s ON s.id = cs.source_id
      WHERE cs.crawl_id = ? ORDER BY CASE cs.status WHEN 'running' THEN 0 WHEN 'failed' THEN 1 WHEN 'ok' THEN 2 ELSE 3 END, s.label`).bind(id).all();
    return Response.json({ run, sources: sources.results });
  }
  if (!isFeed(kind)) return jsonError(400, "invalid_feed");
  const run = await env.DB.prepare("SELECT id, feed, crawl_id AS crawlId, status, started_at AS startedAt, finished_at AS finishedAt, error, item_count AS entries, metadata_json AS metadata, json_extract(metadata_json, '$.awaitingEditorial') AS awaitingEditorial, json_extract(metadata_json, '$.candidates') AS candidates FROM feed_runs WHERE id = ? AND feed = ?").bind(id, kind).first();
  return run ? Response.json({ run }) : jsonError(404, "job_not_found");
}

export async function handleStartCrawl(env: Env, now = Math.floor(Date.now() / 1000)): Promise<Response> {
  const run = await startCrawl(env, now, "manual");
  return run ? Response.json(run, { status: 202 }) : jsonError(409, "no_enabled_sources");
}

export async function handleStartFeed(request: Request, env: Env, feed: string, now = Math.floor(Date.now() / 1000)): Promise<Response> {
  if (!isFeed(feed)) return jsonError(400, "invalid_feed");
  const parsed = z.object({ crawlId: z.number().int().positive().nullable().default(null) }).safeParse(await request.json().catch(() => null));
  if (!parsed.success) return jsonError(400, "invalid_build_request");
  const run = await startFeedRun(env, feed, parsed.data.crawlId, now, "manual");
  return run ? Response.json(run, { status: 202 }) : jsonError(409, "completed_crawl_required");
}

export async function handleFeedSchedule(request: Request, env: Env, feed: string, now = Math.floor(Date.now() / 1000)): Promise<Response> {
  if (!isFeed(feed)) return jsonError(400, "invalid_feed");
  const parsed = z.object({ enabled: z.boolean(), intervalMinutes: z.number().int().min(30).max(10080) }).safeParse(await request.json().catch(() => null));
  if (!parsed.success) return jsonError(400, "invalid_schedule");
  const schedule = parsed.data;
  await env.DB.prepare("UPDATE feed_schedules SET enabled = ?, interval_minutes = ?, next_run_at = ? WHERE feed = ?")
    .bind(Number(schedule.enabled), schedule.intervalMinutes, now + schedule.intervalMinutes * 60, feed).run();
  return Response.json({ feed, ...schedule, nextRunAt: now + schedule.intervalMinutes * 60 });
}


export async function handleStopJob(request: Request, env: Env, kind: string, id: number, now = Math.floor(Date.now() / 1000)) {
  const denied = await checkOperatorPassword(request, env.PASSWORD);
  if (denied) return denied;
  if (kind !== "crawl" && !isFeed(kind)) return jsonError(400, "invalid_feed");
  const db = env.DB;
  let row: { status: string } | null;
  if (kind === "crawl") {
    const results = await db.batch([
      db.prepare("UPDATE crawl_runs SET status = 'stopped', finished_at = ? WHERE id = ? AND status = 'running'").bind(now, id),
      db.prepare(`UPDATE crawl_sources SET status = 'stopped', finished_at = ?, lease_until = 0, token = NULL
        WHERE crawl_id = ? AND status IN ('queued','running') AND EXISTS (SELECT 1 FROM crawl_runs WHERE id = ? AND status = 'stopped')`).bind(now, id, id),
      db.prepare("SELECT status FROM crawl_runs WHERE id = ?").bind(id),
    ]);
    row = (results[2]!.results[0] as { status: string } | undefined) ?? null;
  } else {
    const results = await db.batch([
      db.prepare(`UPDATE feed_runs SET status = 'stopped', finished_at = ?, token = NULL, lease_until = 0
        WHERE id = ? AND feed = ? AND status IN ('queued','running')`).bind(now, id, kind),
      db.prepare("SELECT status FROM feed_runs WHERE id = ? AND feed = ?").bind(id, kind),
    ]);
    row = (results[1]!.results[0] as { status: string } | undefined) ?? null;
  }
  if (!row) return jsonError(404, "job_not_found");
  return row.status === "stopped" ? Response.json(row) : jsonError(409, "job_already_finished");
}
