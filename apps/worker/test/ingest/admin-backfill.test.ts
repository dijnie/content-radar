import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { handleBackfill } from "../../src/api/admin-backfill";
import type { IngestEnv } from "../../src/ingest/poll-consumer";
import type { LlmMessage } from "../../src/llm/messages";
import { seedSource } from "../db/seed";

const NOW = Date.UTC(2026, 8, 20, 16, 0, 0) / 1000;
const DAY = 86_400;
const TEXT = "We benchmarked the new LLM agent against production traffic and measured every result.";

function status(id: number, publishedAt: number) {
  return { id: String(id), url: `https://x.com/backfill_acct/status/${id}`, text: `${TEXT} #${id}`, author: { screen_name: "backfill_acct", name: "B" }, created_timestamp: publishedAt, lang: "en", likes: 1 };
}

function setup() {
  const sent: LlmMessage[] = [];
  const requested: string[] = [];
  const sleeps: number[] = [];
  const pages: Record<string, unknown> = {
    "": { code: 200, results: [status(1, NOW - 1 * DAY), status(2, NOW - 2 * DAY)], cursor: { bottom: "page2" } },
    page2: { code: 200, results: [status(3, NOW - 4 * DAY), status(4, NOW - 9 * DAY)], cursor: { bottom: "page3" } },
    page3: { code: 200, results: [status(5, NOW - 20 * DAY)], cursor: { bottom: "page4" } },
  };
  const fetcher = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    requested.push(url.toString());
    return Response.json(pages[url.searchParams.get("cursor") ?? ""] ?? { code: 200, results: [] });
  }) as typeof fetch;
  const testEnv: IngestEnv = {
    DB: env.DB, RAW: env.RAW, GITHUB_TOKEN: "", APP_ORIGIN: "https://radar.example.com",
    LLM_QUEUE: { sendBatch: async (messages: Iterable<{ body: LlmMessage }>) => void sent.push(...[...messages].map((message) => message.body)) } as unknown as Queue<LlmMessage>,
  };
  return { testEnv, sent, requested, sleeps, deps: { now: NOW, fetcher, sleep: async (ms: number) => void sleeps.push(ms) } };
}

const post = (body: unknown) => new Request("https://radar.example.com/api/admin/backfill", { method: "POST", body: JSON.stringify(body) });

describe("handleBackfill", () => {
  it("walks pages back to the cutoff, spaces requests, and marks items as backfill", async () => {
    await env.DB.prepare("INSERT INTO topics (slug, name, keywords_json) VALUES ('ai', 'AI', '[\"llm\"]') ON CONFLICT(slug) DO NOTHING").run();
    const sourceId = await seedSource(env.DB, "x", "backfill_acct");
    const { testEnv, sent, requested, sleeps, deps } = setup();

    const response = await handleBackfill(post({ handle: "Backfill_Acct", days: 7 }), testEnv, deps);
    expect(await response.json()).toMatchObject({ pages: 2, itemsNew: 3, enqueued: 3, stoppedBecause: "reached_cutoff" });
    expect(requested).toHaveLength(2);
    expect(requested.every((url) => new URL(url).host === "api.fxtwitter.com")).toBe(true);
    expect(sleeps).toEqual([2000]);
    expect(sent.every((message) => message.kind === "extract" && message.backfill === true)).toBe(true);

    const { results } = await env.DB.prepare("SELECT external_id, ingest_mode FROM items WHERE source_id = ? ORDER BY external_id").bind(sourceId).all();
    expect(results).toEqual([
      { external_id: "1", ingest_mode: "backfill" },
      { external_id: "2", ingest_mode: "backfill" },
      { external_id: "3", ingest_mode: "backfill" },
    ]);
  });

  it.each([
    [{ handle: "../../admin", days: 3 }, 400, "invalid_handle"],
    [{ handle: "evil.example/x", days: 3 }, 400, "invalid_handle"],
    [{ handle: "backfill_acct", days: 16 }, 400, "invalid_days"],
    [{ handle: "backfill_acct", days: 0 }, 400, "invalid_days"],
    [{ handle: "backfill_acct", days: 1.5 }, 400, "invalid_days"],
    [{ handle: "backfill_acct", days: "7" }, 400, "invalid_days"],
    [{ handle: "not_tracked", days: 3 }, 404, "unknown_source"],
  ])("rejects %j", async (body, code, error) => {
    const { testEnv, requested, deps } = setup();
    const response = await handleBackfill(post(body), testEnv, deps);
    expect(response.status).toBe(code);
    expect(await response.json()).toMatchObject({ error });
    expect(requested).toEqual([]);
  });

  it("refuses a second backfill of the same account while one is running", async () => {
    await seedSource(env.DB, "x", "busy_acct").catch(() => undefined);
    await env.DB.prepare("INSERT INTO job_leases (name, holder, expires_at) VALUES ('backfill:busy_acct', 'first', ?)").bind(NOW + 300).run();
    const { testEnv, requested, deps } = setup();
    const response = await handleBackfill(post({ handle: "busy_acct", days: 3 }), testEnv, deps);
    expect(response.status).toBe(409);
    expect(requested).toEqual([]);
  });

  it("rejects other methods and malformed JSON", async () => {
    const { testEnv, deps } = setup();
    expect((await handleBackfill(new Request("https://radar.example.com/api/admin/backfill"), testEnv, deps)).status).toBe(405);
    const broken = new Request("https://radar.example.com/api/admin/backfill", { method: "POST", body: "{" });
    expect((await handleBackfill(broken, testEnv, deps)).status).toBe(400);
  });
});
