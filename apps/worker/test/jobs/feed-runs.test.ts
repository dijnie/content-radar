import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { EditorialEntry, EditorialFeedResponse } from "@radar/core";
import { runFeedBuild, startFeedRun } from "../../src/jobs/feed-runs";
import { handleFeed, handleFeedDetail, handleFeedRead } from "../../src/api/feeds-routes";

const NOW = 1790000000;
const testEnv = { ...env, POLL_QUEUE: { send: async () => {} } as unknown as Queue };
const entry: EditorialEntry = { key: "item:1", category: "deep-dives", pillar: "architecture", title: "Architecture 100%_safe", summary: "Phân tích kiến trúc", question: "Kết quả được đo như thế nào?", findings: ["An observed result"], score: 72, publishedAt: NOW,
  sources: [{ itemId: 1, url: "https://example.com/paper", title: "Paper", source: "Papers", author: "Author", platform: "rss", publishedAt: NOW }], voices: 1, labLeaders: null, interactions: null, platforms: 1, articles: 1, repository: null, scoreParts: {}, read: false };
let crawlId: number;
beforeEach(async () => {
  await env.DB.batch([env.DB.prepare("DELETE FROM feed_publications"), env.DB.prepare("DELETE FROM feed_entries"), env.DB.prepare("DELETE FROM feed_runs"), env.DB.prepare("DELETE FROM feed_read_state")]);
  const run = await env.DB.prepare("INSERT INTO crawl_runs (trigger, status, started_at, finished_at) VALUES ('manual', 'ok', ?, ?) RETURNING id").bind(NOW - 10, NOW).first<{ id: number }>();
  crawlId = run!.id;
});
const one = async function* () { yield [entry]; };
const get = (query = "") => handleFeed(new Request(`https://radar.example.com/api/feeds/deep-dives${query}`), testEnv, "deep-dives", NOW);
const body = async (query = "") => (await (await get(query)).json()) as EditorialFeedResponse;

describe("independent feed publication", () => {
  it("requires a finished crawl and returns the existing active build on duplicate requests", async () => {
    expect(await startFeedRun(testEnv, "news", 987654, NOW, "manual")).toBeNull();
    const a = await startFeedRun(testEnv, "news", crawlId, NOW, "manual");
    expect(await startFeedRun(testEnv, "news", crawlId, NOW, "manual")).toEqual({ id: a!.id, created: false });
    expect((await startFeedRun(testEnv, "hands-on", crawlId, NOW, "manual"))?.created).toBe(true);
  });
  it("uses the published News threshold and excludes older topics from Recent", async () => {
    const run = (await startFeedRun(testEnv, "news", crawlId, NOW, "manual"))!;
    await runFeedBuild(testEnv, run.id, { now: NOW, build: async function* (context) {
      context.metadata.threshold = 55;
      yield [{ ...entry, key: "story:1", category: "news", score: 55 },
        { ...entry, key: "story:2", category: "news", score: 54 },
        { ...entry, key: "story:3", category: "news", score: 80, publishedAt: NOW - 2 * 86400 }];
    } });
    const getNews = async (query: string) => (await (await handleFeed(new Request(`https://radar.example.com/api/feeds/news${query}`), testEnv, "news", NOW)).json()) as EditorialFeedResponse;
    expect((await getNews("")).entries.map((entry) => entry.key)).toEqual(["story:1"]);
    const week = await getNews("?window=7d");
    expect(week.total).toBe(2);
    expect(week.publication?.total).toBe(3);
    expect(week.threshold).toBe(55);
  });

  it("keeps the previous publication when a rebuild crashes after staging a page", async () => {
    const first = (await startFeedRun(testEnv, "deep-dives", crawlId, NOW, "manual"))!;
    await runFeedBuild(testEnv, first.id, { now: NOW, build: one });
    const second = (await startFeedRun(testEnv, "deep-dives", crawlId, NOW + 1, "manual"))!;
    await expect(runFeedBuild(testEnv, second.id, { now: NOW + 1, build: async function* () { yield [{ ...entry, title: "Invisible update" }]; throw new Error("storage failed"); } })).rejects.toThrow("storage failed");
    expect((await body()).publication?.runId).toBe(first.id);
    expect((await body()).entries[0]!.title).toBe(entry.title);
    expect(await env.DB.prepare("SELECT status FROM feed_runs WHERE id = ?").bind(second.id).first()).toEqual({ status: "failed" });
  });
  it("a worker that loses its token cannot publish or mark a run done", async () => {
    const run = (await startFeedRun(testEnv, "deep-dives", crawlId, NOW, "manual"))!;
    await runFeedBuild(testEnv, run.id, { now: NOW, build: one, beforePublish: async () => { await env.DB.prepare("UPDATE feed_runs SET token = 'new-owner' WHERE id = ?").bind(run.id).run(); } });
    expect(await env.DB.prepare("SELECT * FROM feed_publications").first()).toBeNull();
    expect(await env.DB.prepare("SELECT status FROM feed_runs WHERE id = ?").bind(run.id).first()).toEqual({ status: "running" });
  });
  it("preserves read state across reruns and filters by time and literal search", async () => {
    const run = (await startFeedRun(testEnv, "deep-dives", crawlId, NOW, "manual"))!;
    await runFeedBuild(testEnv, run.id, { now: NOW, build: async function* () { yield [entry, { ...entry, key: "item:2", title: "Older paper", publishedAt: NOW - 40 * 86400 }]; } });
    expect((await body()).total).toBe(1);
    expect((await body("?months=2")).total).toBe(2);
    expect((await body("?q=100%25_safe")).total).toBe(1);
    expect((await body("?q=100x_safe")).total).toBe(0);
    const action = new Request("https://radar.example.com/api/feeds/deep-dives/read", { method: "POST", body: JSON.stringify({ key: entry.key, read: true }) });
    expect((await handleFeedRead(action, testEnv, NOW)).status).toBe(200);
    expect((await body()).total).toBe(0);
    const next = (await startFeedRun(testEnv, "deep-dives", crawlId, NOW + 2, "manual"))!;
    await runFeedBuild(testEnv, next.id, { now: NOW + 2, build: one });
    expect((await body("?state=read")).entries[0]).toMatchObject({ key: entry.key, read: true });
    const detail = await handleFeedDetail(new Request(`https://radar.example.com/api/feeds/deep-dives/detail?key=${entry.key}`), testEnv, "deep-dives");
    expect(await detail.json()).toMatchObject({ entry: { key: entry.key, read: true } });
    expect((await body("?state=read")).counts).toMatchObject({ read: 1, unread: 0 });
  });
  it.each(["?sort=constructor", "?state=all", "?months=4", "?page=0", "?category=__proto__"])("rejects invalid filters %s", async (query) => { expect((await get(query)).status).toBe(400); });
});
