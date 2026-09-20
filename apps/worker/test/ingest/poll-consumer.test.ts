import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { getSource, getSourceHealth } from "../../src/db/sources-repo";
import { dispatchPolls } from "../../src/ingest/dispatch-polls";
import { consumePollBatch, pollSource, type IngestEnv } from "../../src/ingest/poll-consumer";
import type { LlmMessage, PollMessage } from "../../src/llm/messages";
import timelineJson from "../fixtures/x/timeline-simonw.json?raw";
import { seedSource } from "../db/seed";

const NOW = Date.UTC(2026, 8, 20, 16, 0, 0) / 1000;
const TIMELINE = "https://api.fxtwitter.com/2/profile/simonw/statuses";

function fakeQueue<T>() {
  const sent: T[] = [];
  let failing = false;
  const queue = {
    async send(body: T) {
      if (failing) throw new Error("queue unavailable");
      sent.push(body);
    },
    async sendBatch(messages: Iterable<{ body: T }>) {
      if (failing) throw new Error("queue unavailable");
      for (const message of messages) sent.push(message.body);
    },
  } as unknown as Queue<T>;
  return { queue, sent, fail: (value: boolean) => void (failing = value) };
}

function fetcherFor(routes: Record<string, { status: number; body?: string }>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const route = routes[String(input)] ?? { status: 404 };
    return new Response(route.body ?? "", { status: route.status });
  }) as typeof fetch;
}

async function setup() {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO topics (slug, name, keywords_json) VALUES ('ai', 'AI', ?) ON CONFLICT(slug) DO NOTHING").bind(JSON.stringify(["llm", "ai", "claude", "agent", "model"])),
  ]);
  const llm = fakeQueue<LlmMessage>();
  const testEnv: IngestEnv = { DB: env.DB, RAW: env.RAW, LLM_QUEUE: llm.queue, GITHUB_TOKEN: "", APP_ORIGIN: "https://radar.example.com" };
  return { llm, testEnv };
}

const count = async (sql: string, ...binds: unknown[]) => (await env.DB.prepare(sql).bind(...binds).first<{ n: number }>())!.n;

describe("pollSource", () => {
  let sourceId: number;
  beforeEach(async () => {
    sourceId = await seedSource(env.DB, "x", `simonw`).catch(async () => (await env.DB.prepare("SELECT id FROM sources WHERE type='x' AND key='simonw'").first<{ id: number }>())!.id);
  });

  it("is idempotent: a second poll of the same payload adds nothing and re-sends nothing", async () => {
    const { llm, testEnv } = await setup();
    const fetcher = fetcherFor({ [TIMELINE]: { status: 200, body: timelineJson } });

    await pollSource(testEnv, sourceId, { now: NOW, fetcher });
    const items = await count("SELECT COUNT(*) AS n FROM items WHERE source_id = ?", sourceId);
    const sentFirst = llm.sent.length;
    expect(items).toBe(20);
    expect(sentFirst).toBeGreaterThan(0);
    expect(sentFirst).toBe(await count("SELECT COUNT(*) AS n FROM items WHERE source_id = ? AND status = 'queued'", sourceId));
    expect(await count("SELECT COUNT(*) AS n FROM items WHERE source_id = ? AND filter_reason = 'repost'", sourceId)).toBe(6);

    await pollSource(testEnv, sourceId, { now: NOW + 1800, fetcher });
    expect(await count("SELECT COUNT(*) AS n FROM items WHERE source_id = ?", sourceId)).toBe(20);
    expect(llm.sent.length).toBe(sentFirst);
    // Engagement keeps being sampled, which is the time series velocity is built on.
    expect(await count("SELECT COUNT(DISTINCT captured_at) AS n FROM item_metrics m JOIN items i ON i.id = m.item_id WHERE i.source_id = ?", sourceId)).toBe(2);

    const source = await getSource(env.DB, sourceId);
    expect(source?.next_poll_at).toBe(NOW + 1800 + 60 * 60);
    expect(await getSourceHealth(env.DB, sourceId)).toMatchObject({ consecutive_failures: 0, items_last_poll: 0 });
    expect(await count("SELECT COUNT(*) AS n FROM poll_log WHERE source_id = ? AND status = 'ok'", sourceId)).toBe(2);
  });

  it("stores the raw payload in R2 under a date and hash key", async () => {
    const row = await env.DB.prepare("SELECT raw_r2_key FROM items WHERE source_id = ? AND status = 'queued' LIMIT 1").bind(sourceId).first<{ raw_r2_key: string }>();
    expect(row?.raw_r2_key).toMatch(/^raw\/x\/\d{4}\/\d{2}\/\d{2}\/[0-9a-f]{64}\.json$/);
    const object = await env.RAW.get(row!.raw_r2_key);
    expect(await object?.json()).toMatchObject({ text: expect.any(String), raw: expect.any(Object) });
  });

  it("links the source's author key to the crawled handle", async () => {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO authors (author_key, canonical_name) VALUES ('simon-willison', 'Simon Willison') ON CONFLICT DO NOTHING"),
    ]);
    const row = await env.DB.prepare(
      "SELECT COUNT(DISTINCT i.author_id) AS n FROM items i WHERE i.source_id = ? AND i.kind != 'repost'",
    ).bind(sourceId).first<{ n: number }>();
    expect(row?.n).toBe(1);
  });
});

describe("a consumer that dies after the D1 write but before sending", () => {
  it("leaves queued rows with queued_at for the backlog drain, and the message is retried", async () => {
    const { llm, testEnv } = await setup();
    const sourceId = await seedSource(env.DB, "x", "crashy");
    const url = "https://api.fxtwitter.com/2/profile/crashy/statuses";
    const fetcher = fetcherFor({ [url]: { status: 200, body: timelineJson.replaceAll('"id": "21', '"id": "91') } });
    llm.fail(true);

    const outcomes: string[] = [];
    const batch = {
      queue: "radar-poll",
      messages: [{ body: { sourceId }, ack: () => outcomes.push("ack"), retry: () => outcomes.push("retry") }],
    } as unknown as MessageBatch<PollMessage>;
    await consumePollBatch(batch, testEnv, { now: NOW, fetcher });

    expect(outcomes).toEqual(["retry"]);
    expect(llm.sent).toEqual([]);
    const queued = await env.DB.prepare("SELECT COUNT(*) AS n, MIN(queued_at) AS queued_at FROM items WHERE source_id = ? AND status = 'queued'").bind(sourceId).first<{ n: number; queued_at: number }>();
    expect(queued?.n).toBeGreaterThan(0);
    expect(queued?.queued_at).toBe(NOW);
    // The queue outage is not the source's fault.
    expect(await getSourceHealth(env.DB, sourceId)).toBeNull();
  });
});

describe("a failing source", () => {
  it("backs off after five consecutive 403s without affecting another source", async () => {
    const { testEnv } = await setup();
    const blocked = await seedSource(env.DB, "x", "blocked_acct");
    const healthy = await seedSource(env.DB, "x", "healthy_acct");
    const fetcher = fetcherFor({
      "https://api.fxtwitter.com/2/profile/blocked_acct/statuses": { status: 403 },
      "https://fxtwitter.com/blocked_acct/feed.xml": { status: 403 },
      "https://api.fxtwitter.com/2/profile/healthy_acct/statuses": { status: 200, body: JSON.stringify({ code: 200, results: [] }) },
    });

    for (let attempt = 1; attempt <= 5; attempt++) {
      await pollSource(testEnv, blocked, { now: NOW + attempt, fetcher });
      const source = await getSource(env.DB, blocked);
      // Seeded sources use the schema default of 60 minutes; the fifth failure doubles it.
      expect(source?.next_poll_at).toBe(NOW + attempt + (attempt < 5 ? 60 : 120) * 60);
    }
    expect(await getSourceHealth(env.DB, blocked)).toMatchObject({ consecutive_failures: 5, last_error: "blocked:http_403" });

    await pollSource(testEnv, healthy, { now: NOW, fetcher });
    expect(await getSourceHealth(env.DB, healthy)).toMatchObject({ consecutive_failures: 0, last_ok_at: NOW });
  });
});

describe("dispatchPolls", () => {
  it("sends due, enabled sources once and leases them so the next tick does not resend", async () => {
    await env.DB.prepare("UPDATE sources SET next_poll_at = ?", ).bind(NOW + 99_999).run();
    const due = await seedSource(env.DB, "hn", "dispatch-due");
    const disabled = await seedSource(env.DB, "hn", "dispatch-disabled");
    await env.DB.prepare("UPDATE sources SET enabled = 0 WHERE id = ?").bind(disabled).run();
    const poll = fakeQueue<PollMessage>();

    expect(await dispatchPolls({ DB: env.DB, POLL_QUEUE: poll.queue }, NOW)).toBe(1);
    expect(poll.sent).toEqual([{ sourceId: due }]);
    expect(await dispatchPolls({ DB: env.DB, POLL_QUEUE: poll.queue }, NOW + 60)).toBe(0);
    expect(await dispatchPolls({ DB: env.DB, POLL_QUEUE: poll.queue }, NOW + 16 * 60)).toBe(1);
  });
});
