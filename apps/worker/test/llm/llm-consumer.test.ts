import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { upsertItem } from "../../src/db/items-repo";
import { consumeDeadLetters } from "../../src/llm/dlq-consumer";
import { drainBacklog } from "../../src/llm/drain-backlog";
import type { LlmEnv } from "../../src/llm/extract/extract-batch";
import { consumeLlmBatch } from "../../src/llm/llm-consumer";
import type { LlmMessage } from "../../src/llm/messages";
import locationBlocked from "../fixtures/gemini/location-blocked-400.json";
import rateLimited from "../fixtures/gemini/rate-limited-429.json";
import successEnvelope from "../fixtures/gemini/success-envelope.json";
import { itemInput, seedSource } from "../db/seed";

const NOW = Date.UTC(2026, 8, 20, 18, 0, 0) / 1000;
let sequence = 0;

type Reply = { status: number; body: unknown };
const textOf = (n: number) => `Post ${n}: our team measured that latency dropped ${n}% on the internal benchmark after the rewrite of the serving stack.`;

/** Stands in for Gemini: answers every <item> in the prompt with one claim quoting that item verbatim. */
function fakeGemini(script: (call: number, model: string, itemIds: number[]) => Reply | null = () => null) {
  const calls: { model: string; itemIds: number[] }[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const model = /models\/([^:]+):/.exec(String(input))![1]!;
    const prompt: string = JSON.parse(String(init!.body)).contents[0].parts[0].text;
    const items = [...prompt.matchAll(/<item itemId="(\d+)"[^>]*>\n([\s\S]*?)\n<\/item>/g)].map((match) => ({ id: Number(match[1]), text: match[2]! }));
    calls.push({ model, itemIds: items.map((item) => item.id) });
    const scripted = script(calls.length, model, items.map((item) => item.id));
    if (scripted) return Response.json(scripted.body, { status: scripted.status });
    const payload = {
      items: items.map((item) => ({
        itemId: item.id, relevant: true, topics: ["ai", "not-a-topic"],
        claims: [{
          kind: "measurement", text_vi: "Nhóm tác giả đo được độ trễ giảm trên bộ thử nội bộ sau khi viết lại.", text_en: "The team measured a latency drop on its internal benchmark after a rewrite.",
          quote: /latency dropped \d+% on the internal benchmark/.exec(item.text)![0], has_numbers: true, first_hand: true,
          entities: [{ surface: "Serving Stack", type: "product" }, { surface: "serving stack", type: "product" }],
        }],
      })),
    };
    const envelope = structuredClone(successEnvelope) as typeof successEnvelope;
    envelope.candidates[0]!.content.parts[0]!.text = JSON.stringify(payload);
    return Response.json(envelope);
  }) as typeof fetch;
  return { fetcher, calls };
}

function fakeBatch(bodies: LlmMessage[], attempts = 1) {
  const outcomes = new Map<number, string>();
  const messages = bodies.map((body, index) => ({
    body, attempts,
    ack: () => outcomes.set(index, "ack"),
    retry: (options?: { delaySeconds?: number }) => outcomes.set(index, `retry:${options?.delaySeconds}`),
  }));
  return { batch: { queue: "radar-llm", messages } as unknown as MessageBatch<LlmMessage>, outcomes: () => bodies.map((_, index) => outcomes.get(index)) };
}

async function seedItems(count: number, mode: "live" | "backfill" = "live"): Promise<number[]> {
  const sourceId = await seedSource(env.DB, "x", `llm-src-${++sequence}`);
  const ids: number[] = [];
  for (let n = 1; n <= count; n++) {
    const { id } = await upsertItem(env.DB, itemInput({ sourceId, externalId: `llm-${sequence}-${n}`, textExcerpt: textOf(n), ingestMode: mode, fetchedAt: NOW - 3600 }));
    ids.push(id);
  }
  return ids;
}

const statuses = async (ids: number[]) =>
  (await env.DB.prepare(`SELECT status, COUNT(*) AS n FROM items WHERE id IN (${ids.join(",")}) GROUP BY status`).all<{ status: string; n: number }>()).results.reduce<Record<string, number>>((all, row) => ({ ...all, [row.status]: row.n }), {});
const claimCount = async (ids: number[]) => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM claims WHERE item_id IN (${ids.join(",")})`).first<{ n: number }>())!.n;

let sent: LlmMessage[];
let testEnv: LlmEnv;

beforeEach(async () => {
  sent = [];
  testEnv = {
    DB: env.DB, RAW: env.RAW, GEMINI_API_KEY: "test-key",
    LLM_QUEUE: { sendBatch: async (messages: Iterable<{ body: LlmMessage }>) => void sent.push(...[...messages].map((message) => message.body)) } as unknown as Queue<LlmMessage>,
  };
  await env.DB.batch([
    env.DB.prepare("DELETE FROM llm_usage"),
    env.DB.prepare("DELETE FROM llm_calls"),
    env.DB.prepare("DELETE FROM settings WHERE key = 'llm_circuit'"),
    env.DB.prepare("DELETE FROM settings WHERE key = 'core_overrides'"),
    env.DB.prepare("UPDATE llm_models SET exhausted_until = NULL, rpm = 1000, rpd = 1000, enabled = 1"),
    env.DB.prepare("UPDATE items SET status = 'irrelevant' WHERE status = 'queued'"),
    env.DB.prepare("INSERT INTO topics (slug, name, keywords_json) VALUES ('ai', 'AI & Agent', '[]') ON CONFLICT(slug) DO NOTHING"),
  ]);
});

describe("consumeLlmBatch", () => {
  it("parks already queued historical messages while recent items wait, then processes them later", async () => {
    const [old, recent] = await seedItems(2);
    await env.DB.prepare("UPDATE items SET published_at = ? WHERE id = ?").bind(NOW - 30 * 86400, old).run();
    const gemini = fakeGemini();
    const delivery = fakeBatch([{ kind: "extract", itemId: old! }], 6);
    await consumeLlmBatch(delivery.batch, testEnv, { now: NOW, fetcher: gemini.fetcher });
    expect(delivery.outcomes()).toEqual(["ack"]);
    expect(gemini.calls).toEqual([]);
    expect(await statuses([old!])).toEqual({ queued: 1 });
    expect(await env.DB.prepare("SELECT enqueue_attempts FROM items WHERE id = ?").bind(old).first()).toEqual({ enqueue_attempts: 0 });

    await consumeLlmBatch(fakeBatch([{ kind: "extract", itemId: recent! }]).batch, testEnv, { now: NOW, fetcher: gemini.fetcher });
    expect(await drainBacklog(testEnv, NOW)).toEqual({ sent: 1, failed: 0 });
    await consumeLlmBatch(fakeBatch(sent).batch, testEnv, { now: NOW, fetcher: gemini.fetcher });
    expect(gemini.calls.map((call) => call.itemIds)).toEqual([[recent], [old]]);
    expect(await statuses([old!, recent!])).toEqual({ extracted: 2 });
  });

  it.each([7, 14])("uses the configured %i-day window when prioritizing a mixed batch", async (windowDays) => {
    await env.DB.prepare("INSERT INTO settings (key, value_json) VALUES ('core_overrides', ?)").bind(JSON.stringify({ windowDays })).run();
    const [old, recent] = await seedItems(2);
    await env.DB.prepare("UPDATE items SET published_at = ? WHERE id = ?").bind(NOW - 10 * 86400, old).run();
    const gemini = fakeGemini();
    const delivery = fakeBatch([old!, recent!].map((itemId) => ({ kind: "extract", itemId })));
    await consumeLlmBatch(delivery.batch, testEnv, { now: NOW, fetcher: gemini.fetcher });
    expect(delivery.outcomes()).toEqual(["ack", "ack"]);
    expect(gemini.calls.map((call) => call.itemIds)).toEqual([windowDays === 7 ? [recent] : [old, recent]]);
  });

  it("defers historical backfill behind recent work without changing its budget share", async () => {
    const [old] = await seedItems(1, "backfill");
    const [recent] = await seedItems(1);
    await env.DB.prepare("UPDATE items SET published_at = ? WHERE id = ?").bind(NOW - 10 * 86400, old).run();
    const gemini = fakeGemini();
    await consumeLlmBatch(fakeBatch([{ kind: "extract", itemId: old! }]).batch, testEnv, { now: NOW, fetcher: gemini.fetcher });
    expect(gemini.calls).toEqual([]);
    await consumeLlmBatch(fakeBatch([{ kind: "extract", itemId: recent! }]).batch, testEnv, { now: NOW, fetcher: gemini.fetcher });
    expect(await drainBacklog(testEnv, NOW)).toEqual({ sent: 1, failed: 0 });
    expect(sent).toEqual([{ kind: "extract", itemId: old, backfill: true }]);
    await consumeLlmBatch(fakeBatch(sent).batch, testEnv, { now: NOW, fetcher: gemini.fetcher });
    expect(await statuses([old!])).toEqual({ extracted: 1 });
    expect((await env.DB.prepare("SELECT kind, requests FROM llm_usage ORDER BY kind").all()).results).toEqual([{ kind: "extract", requests: 1 }, { kind: "extract_backfill", requests: 1 }]);
  });

  it("extracts 25 items in exactly three calls and stores traceable claims", async () => {
    const ids = await seedItems(25);
    const gemini = fakeGemini();
    for (const chunk of [ids.slice(0, 10), ids.slice(10, 20), ids.slice(20)]) {
      const { batch, outcomes } = fakeBatch(chunk.map((itemId) => ({ kind: "extract", itemId })));
      await consumeLlmBatch(batch, testEnv, { now: NOW, fetcher: gemini.fetcher });
      expect(outcomes().every((outcome) => outcome === "ack")).toBe(true);
    }
    expect(gemini.calls.map((call) => call.itemIds.length)).toEqual([10, 10, 5]);
    expect(await statuses(ids)).toEqual({ extracted: 25 });

    const claim = await env.DB.prepare("SELECT c.*, i.text_excerpt FROM claims c JOIN items i ON i.id = c.item_id WHERE c.item_id = ?").bind(ids[6]).first<Record<string, unknown>>();
    expect(String(claim!.text_excerpt)).toContain(String(claim!.quote));
    expect(claim).toMatchObject({ kind: "measurement", has_numbers: 1, first_hand: 1, model: "gemini-3.8-flash", prompt_version: 1, topics_json: '["ai"]' });
    expect(claim!.llm_call_id).toEqual(expect.any(Number));
    // Two surface forms of one entity collapse to a single normalized mention.
    const mentions = await env.DB.prepare("SELECT normalized FROM entity_mentions WHERE claim_id = ?").bind(claim!.id).all();
    expect(mentions.results).toEqual([{ normalized: "serving stack" }]);
    expect(await env.DB.prepare("SELECT SUM(requests) AS n FROM llm_usage").first()).toEqual({ n: 3 });
  });

  it("replaying a half-processed batch creates no duplicate claims and spends no call on finished items", async () => {
    const ids = await seedItems(6);
    const gemini = fakeGemini();
    await consumeLlmBatch(fakeBatch(ids.slice(0, 3).map((itemId) => ({ kind: "extract", itemId }))).batch, testEnv, { now: NOW, fetcher: gemini.fetcher });
    // The consumer "died" before acknowledging: the queue redelivers the whole batch of six.
    const replay = fakeBatch(ids.map((itemId) => ({ kind: "extract", itemId })));
    await consumeLlmBatch(replay.batch, testEnv, { now: NOW, fetcher: gemini.fetcher });

    expect(replay.outcomes().every((outcome) => outcome === "ack")).toBe(true);
    expect(gemini.calls.map((call) => call.itemIds)).toEqual([ids.slice(0, 3), ids.slice(3)]);
    expect(await claimCount(ids)).toBe(6);

    await env.DB.prepare(`UPDATE items SET status = 'queued' WHERE id IN (${ids.join(",")})`).run();
    await consumeLlmBatch(fakeBatch(ids.map((itemId) => ({ kind: "extract", itemId }))).batch, testEnv, { now: NOW, fetcher: gemini.fetcher });
    expect(await claimCount(ids)).toBe(6);
  });

  it("when every model is out of daily budget: acks, leaves items queued, calls nothing, and the drain resends them later", async () => {
    const ids = await seedItems(4);
    await env.DB.prepare("UPDATE llm_models SET rpd = 0").run();
    const gemini = fakeGemini();
    const { batch, outcomes } = fakeBatch(ids.map((itemId) => ({ kind: "extract", itemId })));
    await consumeLlmBatch(batch, testEnv, { now: NOW, fetcher: gemini.fetcher });

    expect(outcomes()).toEqual(["ack", "ack", "ack", "ack"]);
    expect(gemini.calls).toEqual([]);
    expect(await statuses(ids)).toEqual({ queued: 4 });
    expect(await drainBacklog(testEnv, NOW)).toEqual({ sent: 0, failed: 0 });

    await env.DB.prepare("UPDATE llm_models SET rpd = 1000").run();
    expect(await drainBacklog(testEnv, NOW)).toEqual({ sent: 4, failed: 0 });
    expect(sent.map((message) => (message as { itemId: number }).itemId).sort()).toEqual([...ids].sort());
    // Just announced: the next tick must not announce them again.
    expect(await drainBacklog(testEnv, NOW + 60)).toEqual({ sent: 0, failed: 0 });
  });

  it("waits seconds, not hours, when only the per-minute limit is hit", async () => {
    const ids = await seedItems(2);
    await env.DB.prepare("UPDATE llm_models SET rpm = 0").run();
    const gemini = fakeGemini();
    const { batch, outcomes } = fakeBatch(ids.map((itemId) => ({ kind: "extract", itemId })));
    await consumeLlmBatch(batch, testEnv, { now: NOW, fetcher: gemini.fetcher });
    expect(outcomes()).toEqual(["retry:60", "retry:60"]);
    expect(gemini.calls).toEqual([]);
  });

  it("returns prolonged quota waits to D1 before the queue dead-letters untouched items", async () => {
    const ids = await seedItems(2);
    await env.DB.prepare("UPDATE llm_models SET rpm = 0").run();
    const gemini = fakeGemini();
    const bodies: LlmMessage[] = ids.map((itemId) => ({ kind: "extract", itemId }));

    // Both Wrangler configs allow five retries, hence at most six deliveries.
    for (let attempts = 1; attempts <= 6; attempts++) {
      const delivery = fakeBatch(bodies, attempts);
      await consumeLlmBatch(delivery.batch, testEnv, { now: NOW + (attempts - 1) * 60, fetcher: gemini.fetcher });
      if (delivery.outcomes().every((outcome) => outcome === "ack")) break;
      if (attempts === 6) await consumeDeadLetters(fakeBatch(bodies).batch, testEnv, NOW + 360);
    }

    expect(gemini.calls).toEqual([]);
    expect(await statuses(ids)).toEqual({ queued: 2 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM llm_calls WHERE status = 'dead_letter'").first()).toEqual({ n: 0 });

    // Recovery uses the normal ledger drain; no operator has to repair item status.
    await env.DB.prepare("UPDATE llm_models SET rpm = 1000").run();
    expect(await drainBacklog(testEnv, NOW + 1800)).toEqual({ sent: 2, failed: 0 });
    await consumeLlmBatch(fakeBatch(sent).batch, testEnv, { now: NOW + 1800, fetcher: gemini.fetcher });
    expect(await statuses(ids)).toEqual({ extracted: 2 });
    expect(await claimCount(ids)).toBe(2);
  });

  it("parks known model overload even on the last delivery instead of failing the items", async () => {
    const ids = await seedItems(2);
    const gemini = fakeGemini(() => ({ status: 503, body: { error: { code: 503, message: "overloaded", status: "UNAVAILABLE" } } }));
    const delivery = fakeBatch(ids.map((itemId) => ({ kind: "extract", itemId })), 6);
    await consumeLlmBatch(delivery.batch, testEnv, { now: NOW, fetcher: gemini.fetcher });

    expect(delivery.outcomes()).toEqual(["ack", "ack"]);
    expect(await statuses(ids)).toEqual({ queued: 2 });
    expect(gemini.calls).toHaveLength(3);
    expect(await env.DB.prepare("SELECT SUM(requests) AS n FROM llm_usage").first()).toEqual({ n: 3 });
  });

  it("moves to the second model when the first answers 429, and parks the first", async () => {
    const ids = await seedItems(2);
    const gemini = fakeGemini((call) => (call === 1 ? { status: 429, body: rateLimited } : null));
    await consumeLlmBatch(fakeBatch(ids.map((itemId) => ({ kind: "extract", itemId }))).batch, testEnv, { now: NOW, fetcher: gemini.fetcher });

    expect(gemini.calls.map((call) => call.model)).toEqual(["gemini-3.8-flash", "gemini-3.7-flash"]);
    expect(await statuses(ids)).toEqual({ extracted: 2 });
    const parked = await env.DB.prepare("SELECT exhausted_until FROM llm_models WHERE model = 'gemini-3.8-flash'").first<{ exhausted_until: number }>();
    expect(parked?.exhausted_until).toBeGreaterThan(NOW);
    // The 429 counted against Google's quota, so its reservation stands.
    const usage = await env.DB.prepare("SELECT model, requests FROM llm_usage ORDER BY model").all();
    expect(usage.results).toEqual([{ model: "gemini-3.7-flash", requests: 1 }, { model: "gemini-3.8-flash", requests: 1 }]);
  });

  it("an overloaded model costs quota, rests for a few minutes, and the chain moves on", async () => {
    const ids = await seedItems(2);
    const overloaded = { error: { code: 503, message: "This model is currently experiencing high demand.", status: "UNAVAILABLE" } };
    const gemini = fakeGemini((_call, model) => (model === "gemini-3.8-flash" ? { status: 503, body: overloaded } : null));
    for (let round = 0; round < 6; round++) {
      const more = round === 0 ? ids : await seedItems(1);
      const { batch, outcomes } = fakeBatch(more.map((itemId) => ({ kind: "extract", itemId })));
      await consumeLlmBatch(batch, testEnv, { now: NOW + round, fetcher: gemini.fetcher });
      expect(outcomes().every((outcome) => outcome === "ack")).toBe(true);
    }
    expect(await statuses(ids)).toEqual({ extracted: 2 });
    // Measured on the free tier: a 503 still counts against the 20 daily requests. So the overloaded model is
    // asked once, charged for it, and left alone while it rests; the other five batches go straight to the next model.
    expect(gemini.calls.map((call) => call.model)).toEqual(["gemini-3.8-flash", ...Array(6).fill("gemini-3.7-flash")]);
    expect((await env.DB.prepare("SELECT model, SUM(requests) AS n FROM llm_usage GROUP BY model ORDER BY model").all()).results).toEqual([{ model: "gemini-3.7-flash", n: 6 }, { model: "gemini-3.8-flash", n: 1 }]);
    expect(await env.DB.prepare("SELECT exhausted_until FROM llm_models WHERE model = 'gemini-3.8-flash'").first()).toEqual({ exhausted_until: NOW + 180 });
    expect(await env.DB.prepare("SELECT value_json FROM settings WHERE key = 'llm_circuit'").first()).toBeNull();
  });

  it("when the whole chain is overloaded it asks each model once, then waits for them to rest instead of burning quota", async () => {
    const ids = await seedItems(1);
    const gemini = fakeGemini(() => ({ status: 503, body: { error: { code: 503, message: "overloaded", status: "UNAVAILABLE" } } }));
    const first = fakeBatch([{ kind: "extract", itemId: ids[0]! }]);
    await consumeLlmBatch(first.batch, testEnv, { now: NOW, fetcher: gemini.fetcher });
    expect(gemini.calls.map((call) => call.model)).toEqual(["gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.6-flash"]);
    expect(first.outcomes()).toEqual(["retry:30"]);
    expect(await env.DB.prepare("SELECT SUM(requests) AS n FROM llm_usage").first()).toEqual({ n: 3 });

    // The redelivery a minute later finds all three resting: not one more request is spent.
    const again = fakeBatch([{ kind: "extract", itemId: ids[0]! }], 2);
    await consumeLlmBatch(again.batch, testEnv, { now: NOW + 60, fetcher: gemini.fetcher });
    expect(gemini.calls).toHaveLength(3);
    expect(again.outcomes()).toEqual(["retry:60"]);
    // Once they have rested, the work resumes.
    const later = fakeBatch([{ kind: "extract", itemId: ids[0]! }], 3);
    await consumeLlmBatch(later.batch, testEnv, { now: NOW + 181, fetcher: fakeGemini().fetcher });
    expect(await statuses(ids)).toEqual({ extracted: 1 });
  });

  it("releases the reservation and retries with a growing delay when the call never counted", async () => {
    const ids = await seedItems(1);
    const gemini = fakeGemini(() => ({ status: 400, body: locationBlocked }));
    const first = fakeBatch([{ kind: "extract", itemId: ids[0]! }], 1);
    await consumeLlmBatch(first.batch, testEnv, { now: NOW, fetcher: gemini.fetcher });
    const third = fakeBatch([{ kind: "extract", itemId: ids[0]! }], 3);
    await consumeLlmBatch(third.batch, testEnv, { now: NOW, fetcher: gemini.fetcher });

    expect(first.outcomes()).toEqual(["retry:30"]);
    expect(third.outcomes()).toEqual(["retry:120"]);
    expect(await env.DB.prepare("SELECT COALESCE(SUM(requests), 0) AS n FROM llm_usage").first()).toEqual({ n: 0 });
    expect(await env.DB.prepare("SELECT status, COUNT(*) AS n FROM llm_calls GROUP BY status").all().then((r) => r.results)).toEqual([{ status: "location_blocked", n: 2 }]);
  });

  it("opens the circuit after five location failures and then stops calling", async () => {
    const ids = await seedItems(1);
    const gemini = fakeGemini(() => ({ status: 400, body: locationBlocked }));
    for (let i = 0; i < 5; i++) await consumeLlmBatch(fakeBatch([{ kind: "extract", itemId: ids[0]! }]).batch, testEnv, { now: NOW, fetcher: gemini.fetcher });
    const parked = fakeBatch([{ kind: "extract", itemId: ids[0]! }]);
    await consumeLlmBatch(parked.batch, testEnv, { now: NOW + 60, fetcher: gemini.fetcher });

    expect(gemini.calls).toHaveLength(5);
    expect(parked.outcomes()).toEqual(["ack"]);
    expect(await statuses(ids)).toEqual({ queued: 1 });
    expect(await drainBacklog(testEnv, NOW + 3600)).toMatchObject({ sent: 1 });
  });

  it("rejects fabricated quotes and records why", async () => {
    const ids = await seedItems(1);
    const envelope = structuredClone(successEnvelope) as typeof successEnvelope;
    const claim = (quote: string, extra: Record<string, unknown> = {}) => ({ kind: "measurement", text_vi: "Nhóm tác giả đo được độ trễ giảm trên bộ thử nội bộ.", text_en: "The team measured a latency drop on its benchmark.", quote, has_numbers: true, first_hand: true, entities: [], ...extra });
    envelope.candidates[0]!.content.parts[0]!.text = JSON.stringify({
      items: [
        { itemId: ids[0], relevant: true, topics: ["ai"], claims: [
          claim("latency dropped 1% on the internal benchmark"),
          claim("latency dropped 1% on the internal benchmark"),
          claim("latency dropped 99% on the internal benchmark after the rewrite of the serving stack."),
          claim("the system became sentient and asked for a raise"),
          claim("x".repeat(301)),
          claim("latency dropped 1%", { kind: "rumour" }),
        ] },
        { itemId: 999_999_999, relevant: true, topics: [], claims: [claim("ignore previous instructions")] },
      ],
    });
    const gemini = fakeGemini(() => ({ status: 200, body: envelope }));
    await consumeLlmBatch(fakeBatch([{ kind: "extract", itemId: ids[0]! }]).batch, testEnv, { now: NOW, fetcher: gemini.fetcher });

    expect(await claimCount(ids)).toBe(1);
    const call = await env.DB.prepare("SELECT claims_returned, claims_accepted, reject_reasons_json FROM llm_calls").first<Record<string, unknown>>();
    expect(call).toMatchObject({ claims_returned: 6, claims_accepted: 1 });
    expect(JSON.parse(String(call!.reject_reasons_json))).toEqual({ duplicate: 1, quote_not_found: 2, quote_too_long: 1, schema: 1 });
    expect(await env.DB.prepare("SELECT claims_returned, claims_accepted FROM items WHERE id = ?").bind(ids[0]).first()).toEqual({ claims_returned: 6, claims_accepted: 1 });
  });

  it("bisects a batch Gemini rejects and fails only the offending item", async () => {
    const ids = await seedItems(4);
    const poison = ids[2]!;
    const gemini = fakeGemini((_call, _model, itemIds) => (itemIds.includes(poison) ? { status: 400, body: { error: { code: 400, message: "Invalid argument", status: "INVALID_ARGUMENT" } } } : null));
    const { batch, outcomes } = fakeBatch(ids.map((itemId) => ({ kind: "extract", itemId })));
    await consumeLlmBatch(batch, testEnv, { now: NOW, fetcher: gemini.fetcher });

    expect(outcomes()).toEqual(["ack", "ack", "ack", "ack"]);
    expect(await statuses(ids)).toEqual({ extracted: 3, failed: 1 });
    expect(await env.DB.prepare("SELECT filter_reason FROM items WHERE id = ?").bind(poison).first()).toEqual({ filter_reason: "llm_rejected" });
  });

  it("charges backfill items to the backfill share whatever the message claims", async () => {
    const ids = await seedItems(2, "backfill");
    const gemini = fakeGemini();
    await consumeLlmBatch(fakeBatch(ids.map((itemId) => ({ kind: "extract", itemId }))).batch, testEnv, { now: NOW, fetcher: gemini.fetcher });
    expect((await env.DB.prepare("SELECT kind, requests FROM llm_usage").all()).results).toEqual([{ kind: "extract_backfill", requests: 1 }]);
  });

});

describe("extraction attempts", () => {
  it("are not spent by wake-ups that never reach Gemini, only by real calls", async () => {
    const ids = await seedItems(2);
    const attempts = async () => (await env.DB.prepare(`SELECT MAX(enqueue_attempts) AS n FROM items WHERE id IN (${ids.join(",")})`).first<{ n: number }>())!.n;
    const gemini = fakeGemini();

    // A day without budget: thirty drains and thirty parked batches later the items are untouched.
    await env.DB.prepare("UPDATE llm_models SET rpd = 0").run();
    for (let tick = 0; tick < 30; tick++) {
      await env.DB.prepare(`UPDATE items SET queued_at = 0 WHERE id IN (${ids.join(",")})`).run();
      await drainBacklog(testEnv, NOW + tick * 1800);
      await consumeLlmBatch(fakeBatch(ids.map((itemId) => ({ kind: "extract", itemId }))).batch, testEnv, { now: NOW + tick * 1800, fetcher: gemini.fetcher });
    }
    expect(await attempts()).toBe(0);
    expect(await statuses(ids)).toEqual({ queued: 2 });

    // A call Gemini rejects is a real attempt.
    await env.DB.prepare("UPDATE llm_models SET rpd = 1000").run();
    const rejecting = fakeGemini(() => ({ status: 200, body: { candidates: [{ content: { parts: [{ text: "not json" }] } }] } }));
    await consumeLlmBatch(fakeBatch([{ kind: "extract", itemId: ids[0]! }]).batch, testEnv, { now: NOW, fetcher: rejecting.fetcher });
    expect(await env.DB.prepare("SELECT status, enqueue_attempts FROM items WHERE id = ?").bind(ids[0]).first()).toEqual({ status: "failed", enqueue_attempts: 1 });
  });
});

describe("drainBacklog", () => {
  it("reserves scarce extraction capacity for recent items even when old items arrived first", async () => {
    const old = await seedItems(20);
    const recent = await seedItems(10);
    await env.DB.prepare(`UPDATE items SET published_at = ? WHERE id IN (${old.join(",")})`).bind(NOW - 30 * 86400).run();
    await env.DB.prepare("UPDATE llm_models SET rpd = 0").run();
    await env.DB.prepare("UPDATE llm_models SET rpd = 2 WHERE model = 'gemini-3.8-flash'").run();
    expect(await drainBacklog(testEnv, NOW)).toEqual({ sent: 10, failed: 0 });
    expect(sent.map((message) => (message as { itemId: number }).itemId)).toEqual(recent);
    // Recent work is still queued but cannot be announced again yet. Old work must wait too.
    expect(await drainBacklog(testEnv, NOW + 60)).toEqual({ sent: 0, failed: 0 });
    expect(await statuses(old)).toEqual({ queued: 20 });
  });

  it("serves live items before backfill, oldest first, and gives up after 20 attempts", async () => {
    await env.DB.prepare("UPDATE llm_models SET rpd = 0").run();
    await env.DB.prepare("UPDATE llm_models SET rpd = 10 WHERE model = 'gemini-3.8-flash'").run();
    const backfill = await seedItems(3, "backfill");
    const live = await seedItems(3);
    const stuck = (await seedItems(1))[0]!;
    await env.DB.prepare("UPDATE items SET enqueue_attempts = 20 WHERE id = ?").bind(stuck).run();

    const result = await drainBacklog(testEnv, NOW);
    expect(result).toEqual({ sent: 6, failed: 1 });
    expect(sent.slice(0, 3).map((message) => (message as { itemId: number }).itemId)).toEqual(live);
    expect(sent.slice(3)).toEqual(backfill.map((itemId) => ({ kind: "extract", itemId, backfill: true })));
    expect(await env.DB.prepare("SELECT status, filter_reason FROM items WHERE id = ?").bind(stuck).first()).toEqual({ status: "failed", filter_reason: "enqueue_attempts_exceeded" });
    // A wake-up is recorded, but it is not an attempt.
    expect(await env.DB.prepare("SELECT enqueue_attempts, queued_at FROM items WHERE id = ?").bind(live[0]).first()).toEqual({ enqueue_attempts: 0, queued_at: NOW });
  });
});

describe("consumeDeadLetters", () => {
  it("marks a dead-lettered extraction as failed with a visible reason", async () => {
    const [itemId] = await seedItems(1);
    const acks: number[] = [];
    const batch = { queue: "radar-dlq", messages: [{ body: { kind: "extract", itemId }, ack: () => acks.push(1) }, { body: { sourceId: 5 }, ack: () => acks.push(2) }] } as unknown as MessageBatch<LlmMessage>;
    await consumeDeadLetters(batch, { DB: env.DB }, NOW);
    expect(acks).toEqual([1, 2]);
    expect(await env.DB.prepare("SELECT status, filter_reason FROM items WHERE id = ?").bind(itemId).first()).toEqual({ status: "failed", filter_reason: "dead_letter" });
    expect(await env.DB.prepare("SELECT status FROM llm_calls WHERE status = 'dead_letter'").first()).toEqual({ status: "dead_letter" });
  });
});
