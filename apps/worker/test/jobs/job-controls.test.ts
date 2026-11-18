import type { FeedKind, JobsResponse } from "@radar/core";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import worker from "../../src/index";
import { pollSource } from "../../src/ingest/poll-consumer";
import { claimCrawlSource, finishCrawlSource, recoverCrawls } from "../../src/jobs/crawl-runs";
import { recoverFeedRuns, runFeedBuild } from "../../src/jobs/feed-runs";
import { seedSource } from "../db/seed";

const origin = "https://radar.example.com";
const now = Math.floor(Date.now() / 1000);
const testEnv = { ...env, PASSWORD: crypto.randomUUID() };
const credentials = "Basic " + btoa("settings:" + testEnv.PASSWORD);

function request(path: string, init?: RequestInit) {
  return worker.fetch(new Request(origin + path, init) as Parameters<typeof worker.fetch>[0], testEnv);
}

function stop(kind: "crawl" | FeedKind, id: number, headers: Record<string, string> = {}) {
  return request(`/api/jobs/${kind}/${id}/stop`, {
    method: "POST", body: "{}",
    headers: { Origin: origin, "Content-Type": "application/json", Authorization: credentials, ...headers },
  });
}

async function seedCrawl(status: "ok" | "running" = "ok") {
  const run = await env.DB.prepare("INSERT INTO crawl_runs (trigger, status, started_at, finished_at) VALUES ('manual', ?, ?, ?) RETURNING id")
    .bind(status, now - 10, status === "ok" ? now - 5 : null).first<{ id: number }>();
  return run!.id;
}

async function seedFeed(crawlId: number, kind: FeedKind, status: "queued" | "done") {
  const run = await env.DB.prepare("INSERT INTO feed_runs (feed, crawl_id, trigger, status, started_at, finished_at) VALUES (?, ?, 'manual', ?, ?, ?) RETURNING id")
    .bind(kind, crawlId, status, now - 2, status === "done" ? now - 1 : null).first<{ id: number }>();
  return run!.id;
}

describe("job stop controls", () => {
  it("requires a same-origin JSON request and the settings password", async () => {
    const id = await seedFeed(await seedCrawl(), "hands-on", "queued");
    expect((await stop("hands-on", id, { Authorization: "" })).status).toBe(401);
    expect((await stop("hands-on", id, { Authorization: "Basic " + btoa("settings:wrong") })).status).toBe(403);
    expect((await stop("hands-on", id, { Origin: "https://other.example" })).status).toBe(403);
    expect((await stop("hands-on", id, { "Content-Type": "text/plain" })).status).toBe(415);
    expect(await (await request(`/api/jobs/hands-on/${id}`)).json()).toMatchObject({ run: { status: "queued" } });
    expect((await stop("hands-on", id)).status).toBe(200);
  });

  it("preserves finished sources, stops pending work, and fences a late result on replay", async () => {
    const id = await seedCrawl("running");
    const done = await seedSource(env.DB, "x", "stop-finished");
    const running = await seedSource(env.DB, "x", "stop-running");
    const queued = await seedSource(env.DB, "x", "stop-queued");
    await env.DB.batch([
      env.DB.prepare("INSERT INTO crawl_sources (crawl_id, source_id, status, items_new, finished_at) VALUES (?, ?, 'ok', 3, ?)").bind(id, done, now - 4),
      env.DB.prepare("INSERT INTO crawl_sources (crawl_id, source_id) VALUES (?, ?), (?, ?)").bind(id, running, id, queued),
    ]);
    const token = await claimCrawlSource(env.DB, id, running, now);
    expect(token).toBeTruthy();

    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await stop("crawl", id);
      expect(result.status).toBe(200);
      expect(await result.json()).toMatchObject({ status: "stopped" });
    }

    const queue = { sendBatch: vi.fn() };
    await recoverCrawls({ DB: env.DB, POLL_QUEUE: queue as unknown as Queue }, now + 1000);
    expect(queue.sendBatch).not.toHaveBeenCalled();
    expect(await claimCrawlSource(env.DB, id, queued, now + 1000)).toBeNull();
    await finishCrawlSource(env.DB, id, running, token!, now + 1000, 99, null);
    const detail = await (await request(`/api/jobs/crawl/${id}`)).json() as { run: { status: string }; sources: { sourceId: number; status: string; itemsNew: number }[] };
    expect(detail.run.status).toBe("stopped");
    expect(detail.sources.find((s) => s.sourceId === done)).toMatchObject({ status: "ok", itemsNew: 3 });
    expect(detail.sources.find((s) => s.sourceId === running)?.itemsNew).toBe(0);
    const jobs = await (await request("/api/jobs")).json() as JobsResponse;
    expect(jobs.crawls.find((job) => job.id === id)).toMatchObject({ status: "stopped", itemsNew: 3 });
  });

  it.each(["ok", "error"])("protects source scheduling when Stop wins immediately before the final %s poll writes", async (outcome) => {
    const id = await seedCrawl("running");
    const source = await seedSource(env.DB, "x", `stop-before-write-${outcome}`);
    await env.DB.prepare("INSERT INTO crawl_sources (crawl_id, source_id) VALUES (?, ?)").bind(id, source).run();
    const token = (await claimCrawlSource(env.DB, id, source, now))!;
    const nextRun = now + 7200;
    let intercepted = false;
    const db = {
      prepare: (sql: string) => env.DB.prepare(sql),
      batch: async (statements: D1PreparedStatement[]) => {
        if (!intercepted) {
          intercepted = true;
          expect((await stop("crawl", id)).status).toBe(200);
          // A later crawl can acquire this source as soon as Stop commits.
          await env.DB.prepare("UPDATE sources SET next_poll_at = ? WHERE id = ?").bind(nextRun, source).run();
        }
        return env.DB.batch(statements);
      },
    } as D1Database;
    await pollSource({ ...testEnv, DB: db }, source, {
      now, crawl: { id, token }, adapters: { x: { type: "x", poll: async () => {
        if (outcome === "error") throw new Error("upstream timeout");
        return { items: [], metrics: [] };
      } } },
    });
    expect(intercepted).toBe(true);
    expect(await env.DB.prepare("SELECT next_poll_at FROM sources WHERE id = ?").bind(source).first("next_poll_at")).toBe(nextRun);
    expect(await env.DB.prepare("SELECT * FROM source_health WHERE source_id = ?").bind(source).first()).toBeNull();
    expect(await env.DB.prepare("SELECT * FROM poll_log WHERE source_id = ?").bind(source).first()).toBeNull();
  });

  it("keeps the previous publication when a running feed is stopped immediately before publish", async () => {
    const crawl = await seedCrawl();
    const published = await seedFeed(crawl, "news", "done");
    await env.DB.prepare("INSERT INTO feed_publications (feed, run_id) VALUES ('news', ?)").bind(published).run();
    const pending = await seedFeed(crawl, "news", "queued");
    expect((await stop("deep-dives", pending)).status).toBe(404);
    await runFeedBuild(testEnv, pending, {
      now, build: async function* () { yield []; },
      beforePublish: async () => { expect((await stop("news", pending)).status).toBe(200); },
    });
    const queue = { send: vi.fn() };
    await recoverFeedRuns({ DB: env.DB, POLL_QUEUE: queue as unknown as Queue }, now + 1000);
    expect(queue.send).not.toHaveBeenCalledWith({ kind: "build-feed", runId: pending });
    const build = vi.fn(async function* () { yield []; });
    await runFeedBuild(testEnv, pending, { now: now + 1000, build });
    expect(build).not.toHaveBeenCalled();
    expect(await env.DB.prepare("SELECT run_id FROM feed_publications WHERE feed = 'news'").first("run_id")).toBe(published);
    expect((await stop("news", published)).status).toBe(409);
    expect((await stop("news", pending)).status).toBe(200);
    expect(await (await request(`/api/jobs/news/${pending}`)).json()).toMatchObject({ run: { status: "stopped" } });
    const jobs = await (await request("/api/jobs")).json() as JobsResponse;
    expect(jobs.builds.find((job) => job.id === pending && job.kind === "news")?.status).toBe("stopped");
  });

  it("distinguishes a completed crawl from a missing job and stops a queued deep dive", async () => {
    const completed = await seedCrawl();
    expect((await stop("crawl", completed)).status).toBe(409);
    expect((await stop("crawl", 987654)).status).toBe(404);
    const queued = await seedFeed(completed, "deep-dives", "queued");
    expect((await stop("deep-dives", queued)).status).toBe(200);
    expect(await (await request(`/api/jobs/deep-dives/${queued}`)).json()).toMatchObject({ run: { status: "stopped" } });
  });
});
