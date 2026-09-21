import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { JobsResponse } from "@radar/core";
import { handleFeedSchedule, handleJobDetail, handleJobs, handleStartFeed } from "../../src/api/jobs-routes";

const NOW = 1790000000;
const post = (body: unknown) => new Request("https://radar.example.com/api/jobs/feeds/news", { method: "POST", body: JSON.stringify(body) });

describe("Jobs API", () => {
  it("filters failures by date and exposes source-level diagnostics", async () => {
    const source = (await env.DB.prepare("INSERT INTO sources (type, key, label) VALUES ('rss', 'jobs-api', 'Test source') RETURNING id").first<{ id: number }>())!.id;
    const run = (await env.DB.prepare("INSERT INTO crawl_runs (trigger, status, started_at, finished_at) VALUES ('manual', 'partial', ?, ?) RETURNING id").bind(NOW, NOW + 1).first<{ id: number }>())!.id;
    await env.DB.batch([
      env.DB.prepare("INSERT INTO crawl_sources (crawl_id, source_id, status, error) VALUES (?, ?, 'failed', 'upstream timeout')").bind(run, source),
      env.DB.prepare("INSERT INTO crawl_runs (trigger, status, started_at, finished_at) VALUES ('schedule', 'failed', ?, ?)").bind(NOW - 10 * 86400, NOW - 10 * 86400 + 1),
    ]);
    const result = await handleJobs(new Request("https://radar.example.com/api/jobs?failures=1&days=7"), env, NOW + 2);
    const body = await result.json() as JobsResponse;
    expect(body.total).toBe(1);
    expect(body.crawls[0]).toMatchObject({ id: run, sources: 1, failures: 1, status: "partial" });
    expect(await (await handleJobDetail(env, "crawl", run)).json()).toMatchObject({ sources: [{ label: "Test source", error: "upstream timeout" }] });
  });
  it("validates schedules and persists independent intervals", async () => {
    expect((await handleFeedSchedule(post({ enabled: true, intervalMinutes: 29 }), env, "news", NOW)).status).toBe(400);
    expect((await handleFeedSchedule(post({ enabled: false, intervalMinutes: 120 }), env, "news", NOW)).status).toBe(200);
    expect(await env.DB.prepare("SELECT enabled, interval_minutes, next_run_at FROM feed_schedules WHERE feed = 'news'").first()).toEqual({ enabled: 0, interval_minutes: 120, next_run_at: NOW + 7200 });
    expect(await env.DB.prepare("SELECT interval_minutes FROM feed_schedules WHERE feed = 'hands-on'").first()).toEqual({ interval_minutes: 1440 });
  });
  it("rejects invalid filters, feeds and missing completed crawls", async () => {
    expect((await handleJobs(new Request("https://radar.example.com/api/jobs?days=0"), env, NOW)).status).toBe(400);
    expect((await handleStartFeed(post({}), env, "unknown", NOW)).status).toBe(400);
    expect((await handleStartFeed(post({ crawlId: 987654 }), env, "news", NOW)).status).toBe(409);
  });
});
