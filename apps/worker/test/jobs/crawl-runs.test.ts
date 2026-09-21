import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { startCrawl, claimCrawlSource, finishCrawlSource, recoverCrawls } from "../../src/jobs/crawl-runs";
import { consumePollBatch, type IngestEnv } from "../../src/ingest/poll-consumer";
import type { PollMessage } from "../../src/llm/messages";
import { seedSource } from "../db/seed";

const NOW = 1_790_000_000;
const sent: PollMessage[] = [];
const queue = { sendBatch: async (messages: { body: PollMessage }[]) => { sent.push(...messages.map((m) => m.body)); } } as unknown as Queue;
const testEnv = { DB: env.DB, POLL_QUEUE: queue };

beforeEach(async () => {
  sent.length = 0;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM crawl_items"), env.DB.prepare("DELETE FROM crawl_sources"), env.DB.prepare("DELETE FROM crawl_runs"),
    env.DB.prepare("UPDATE sources SET enabled = 0"),
  ]);
});

describe("durable crawl runs", () => {
  it("records intent before dispatch and concurrent starts return the same run", async () => {
    const id = await seedSource(env.DB, "x", "crawl-once");
    const first = await startCrawl(testEnv, NOW, "manual");
    const second = await startCrawl(testEnv, NOW, "manual");
    expect(first).toMatchObject({ created: true });
    expect(second).toEqual({ id: first!.id, created: false });
    expect(sent).toEqual([{ sourceId: id, crawlId: first!.id }]);
    expect(await env.DB.prepare("SELECT status FROM crawl_sources WHERE crawl_id = ?").bind(first!.id).first()).toEqual({ status: "queued" });
  });

  it("finishes only after all sources, records partial failure and fences expired workers", async () => {
    const a = await seedSource(env.DB, "x", "crawl-a");
    const b = await seedSource(env.DB, "x", "crawl-b");
    const run = (await startCrawl(testEnv, NOW, "manual"))!;
    const old = (await claimCrawlSource(env.DB, run.id, a, NOW))!;
    expect(await claimCrawlSource(env.DB, run.id, a, NOW)).toBeNull();
    const replacement = (await claimCrawlSource(env.DB, run.id, a, NOW + 901))!;
    await finishCrawlSource(env.DB, run.id, a, old, NOW + 902, 999, null);
    expect(await env.DB.prepare("SELECT status FROM crawl_sources WHERE source_id = ? AND crawl_id = ?").bind(a, run.id).first()).toEqual({ status: "running" });
    await finishCrawlSource(env.DB, run.id, a, replacement, NOW + 902, 3, null);
    expect(await env.DB.prepare("SELECT status FROM crawl_runs WHERE id = ?").bind(run.id).first()).toEqual({ status: "running" });
    const tokenB = (await claimCrawlSource(env.DB, run.id, b, NOW + 902))!;
    await finishCrawlSource(env.DB, run.id, b, tokenB, NOW + 903, 0, "source unavailable");
    expect(await env.DB.prepare("SELECT status, finished_at FROM crawl_runs WHERE id = ?").bind(run.id).first()).toEqual({ status: "partial", finished_at: NOW + 903 });
  });

  it("recovers messages lost after recording intent", async () => {
    await seedSource(env.DB, "x", "crawl-lost");
    const broken = { ...testEnv, POLL_QUEUE: { sendBatch: async () => { throw new Error("queue unavailable"); } } as unknown as Queue };
    await expect(startCrawl(broken, NOW, "schedule")).rejects.toThrow("queue unavailable");
    await recoverCrawls(testEnv, NOW + 60);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.crawlId).toBeGreaterThan(0);
  });

  it("a tracked poll freezes source data and stops before AI; redelivery cannot repoll", async () => {
    const sourceId = await seedSource(env.DB, "x", "crawl-data");
    const run = (await startCrawl(testEnv, NOW, "manual"))!;
    let polls = 0;
    let aiMessages = 0;
    const ingestEnv: IngestEnv = { DB: env.DB, RAW: env.RAW, GITHUB_TOKEN: "", APP_ORIGIN: "https://radar.example.com", LLM_QUEUE: { sendBatch: async () => { aiMessages++; } } as unknown as Queue };
    const body = { sourceId, crawlId: run.id };
    const batch = { messages: [{ body, ack() {}, retry() { throw new Error("unexpected retry"); } }] } as unknown as MessageBatch<PollMessage>;
    const deps = { now: NOW, adapters: { x: { type: "x" as const, poll: async () => { polls++; return { items: [{ platform: "x" as const, externalId: "crawl-item", url: "https://x.com/test/status/1", canonicalUrl: "https://x.com/test/status/1", links: [], author: null, kind: "post" as const, parentExternalId: null, title: null, text: "An actual source payload about agent architecture and models.", lang: "en", publishedAt: NOW, raw: {} }], metrics: [] }; } } } };
    await consumePollBatch(batch, ingestEnv, deps);
    await consumePollBatch(batch, ingestEnv, deps);
    expect(polls).toBe(1);
    expect(aiMessages).toBe(0);
    expect(await env.DB.prepare("SELECT status FROM crawl_runs WHERE id = ?").bind(run.id).first()).toEqual({ status: "ok" });
    const stored = await env.DB.prepare("SELECT snapshot_json FROM crawl_items WHERE crawl_id = ?").bind(run.id).first<{ snapshot_json: string }>();
    expect(JSON.parse(stored!.snapshot_json)).toMatchObject({ externalId: "crawl-item", capturedAt: NOW, metrics: null });
  });
});
