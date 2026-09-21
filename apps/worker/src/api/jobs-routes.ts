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
const JOBS_SQL = `SELECT r.id, 'crawl' AS kind, r.status, r.trigger, r.started_at AS startedAt, r.finished_at AS finishedAt,
  NULL AS crawlId, (SELECT COUNT(*) FROM crawl_sources WHERE crawl_id = r.id) AS sources,
  (SELECT COUNT(*) FROM crawl_sources WHERE crawl_id = r.id AND status = 'failed') AS failures,
  (SELECT COUNT(*) FROM crawl_items WHERE crawl_id = r.id AND json_extract(snapshot_json, '$.kind') != 'article') AS posts,
  (SELECT COUNT(*) FROM crawl_items WHERE crawl_id = r.id AND json_extract(snapshot_json, '$.kind') = 'article') AS articles,
  COALESCE((SELECT SUM(items_new) FROM crawl_sources WHERE crawl_id = r.id), 0) AS itemsNew, 0 AS entries, NULL AS error FROM crawl_runs r
  UNION ALL SELECT id, feed, status, trigger, started_at, finished_at, crawl_id, 0, 0, 0, 0, 0, item_count, error FROM feed_runs`;

export async function handleJobs(request: Request, env: Env, now = Math.floor(Date.now() / 1000)): Promise<Response> {
  const parsed = paramsSchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) return jsonError(400, "invalid_job_filters");
  const { days, failures, page } = parsed.data;
  const pageSize = 30;
  const where = "startedAt >= ? AND (? = 0 OR status IN ('partial', 'failed'))";
  const bindings = [now - days * 86400, Number(failures)];
  const [list, total, schedules, timezone] = await Promise.all([
    env.DB.prepare(`SELECT * FROM (${JOBS_SQL}) WHERE ${where} ORDER BY startedAt DESC, kind, id DESC LIMIT ? OFFSET ?`).bind(...bindings, pageSize, (page - 1) * pageSize).all<JobRow>(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM (${JOBS_SQL}) WHERE ${where}`).bind(...bindings).first<{ n: number }>(),
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
    const sources = await env.DB.prepare(`SELECT s.label, s.type, cs.status, cs.items_new AS itemsNew,
      cs.error, cs.attempts FROM crawl_sources cs JOIN sources s ON s.id = cs.source_id
      WHERE cs.crawl_id = ? ORDER BY CASE WHEN cs.status = 'failed' THEN 0 ELSE 1 END, s.label`).bind(id).all();
    return Response.json({ run, sources: sources.results });
  }
  if (!isFeed(kind)) return jsonError(400, "invalid_feed");
  const run = await env.DB.prepare("SELECT id, feed, crawl_id AS crawlId, status, started_at AS startedAt, finished_at AS finishedAt, error, item_count AS entries, metadata_json AS metadata FROM feed_runs WHERE id = ? AND feed = ?").bind(id, kind).first();
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
