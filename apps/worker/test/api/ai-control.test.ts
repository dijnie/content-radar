import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { membersHash } from "../../src/cluster/lineage-step";
import { upsertItem } from "../../src/db/items-repo";
import { insertLlmCall, type LlmKind } from "../../src/db/llm-repo";
import worker from "../../src/index";
import { drainBacklog } from "../../src/llm/drain-backlog";
import { consumeLlmBatch } from "../../src/llm/llm-consumer";
import type { LlmMessage } from "../../src/llm/messages";
import { pacificDay } from "../../src/llm/pacific-day";
import { seedClaims } from "../cluster/seed-claims";
import { itemInput, seedSource } from "../db/seed";
import { seedAi } from "../db/seed-ai";

const origin = "https://radar.example.com";
const model = "test/control-model";
const now = Math.floor(Date.now() / 1000);
const sendBatch = vi.fn();
const testEnv = { ...env, PASSWORD: crypto.randomUUID(), LLM_QUEUE: { sendBatch } as unknown as Queue<LlmMessage> };
const authorization = "Basic " + btoa("settings:" + testEnv.PASSWORD);
const request = (path: string, init?: RequestInit) =>
  worker.fetch(new Request(origin + path, init) as Parameters<typeof worker.fetch>[0], testEnv);
const control = (body: object, headers: Record<string, string> = {}) => request("/api/status/ai-control", {
  method: "POST", body: JSON.stringify(body),
  headers: { Origin: origin, Authorization: authorization, "Content-Type": "application/json", ...headers },
});
const log = async () => (await (await request("/api/status/llm-calls?model=" + encodeURIComponent(model))).json()) as {
  calls: { id: number; status: string; httpStatus: number | null; retryable: number }[];
};
const status = async () => (await (await request("/api/status")).json()) as { llm: {
  unlimited: boolean; paused: boolean; models: { model: string; rpm: number | null; rpd: number | null }[];
  usageToday: { model: string; kind: string; requests: number }[];
  activeCalls: { id: number; at: number; model: string; kind: string; subjects: number; status: string }[];
} };

async function queuedItem() {
  const key = crypto.randomUUID();
  const sourceId = await seedSource(env.DB, "x", key);
  const { id } = await upsertItem(env.DB, itemInput({ sourceId, externalId: key, publishedAt: now, fetchedAt: now }));
  return id;
}

async function queuedItems(count: number) {
  const sourceId = await seedSource(env.DB, "x", crypto.randomUUID());
  const keys = Array.from({ length: count }, () => crypto.randomUUID());
  const { results } = await env.DB.prepare(`INSERT INTO items
    (source_id, platform, external_id, url, canonical_url, kind, published_at, fetched_at, content_hash, status)
    SELECT ?, 'x', value, 'https://x.com/' || value, 'https://x.com/' || value, 'post', ?, ?, value, 'queued'
    FROM json_each(?) RETURNING id`).bind(sourceId, now, now, JSON.stringify(keys)).all<{ id: number }>();
  return results.map(row => row.id).sort((a, b) => a - b);
}

async function consume(itemId: number, fetcher: typeof fetch) {
  const delivery = { body: { kind: "extract", itemId }, attempts: 1, ack: vi.fn(), retry: vi.fn() };
  await consumeLlmBatch({ messages: [delivery] } as unknown as MessageBatch<LlmMessage>, testEnv, { now, fetcher });
  return delivery;
}

function providerResponse(itemId: number) {
  return Response.json({
    choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ items: [{ itemId, relevant: false, topics: [], claims: [] }] }) } }],
    usage: { prompt_tokens: 11, completion_tokens: 3 },
  });
}

function recordCall(kind: LlmKind, itemIds: number[], status = "transient", at = now) {
  return insertLlmCall(env.DB, { at, model, kind, itemIds, promptVersion: 1, status });
}

async function storyFixture(completed: boolean) {
  const ids = await seedClaims(env.DB, [{ tag: "retry", publishedAt: now }]);
  const hash = await membersHash(ids);
  const storyId = (await env.DB.prepare(`INSERT INTO stories
    (headline_vi, score, first_seen_at, last_claim_at, members_hash, synthesized_hash)
    VALUES ('fixture', 80, ?, ?, ?, ?) RETURNING id`).bind(now, now, hash, completed ? hash : null).first<number>("id"))!;
  const run = await env.DB.prepare("INSERT INTO cluster_runs (started_at, heartbeat_at, status, params_json, seed) VALUES (?, ?, 'done', '{}', 1) RETURNING id")
    .bind(now, now).first<number>("id");
  await env.DB.prepare("INSERT INTO story_claims (story_id, claim_id, added_run_id) VALUES (?, ?, ?)").bind(storyId, ids[0], run).run();
  return { storyId, membersHash: hash };
}

beforeEach(async () => {
  sendBatch.mockReset();
  await seedAi(env.DB, { model });
  await env.DB.batch([
    env.DB.prepare("DELETE FROM llm_calls WHERE model = ?").bind(model),
    env.DB.prepare("DELETE FROM llm_usage WHERE model = ?").bind(model),
    env.DB.prepare("UPDATE llm_models SET exhausted_until = NULL WHERE model = ?").bind(model),
    env.DB.prepare("DELETE FROM settings WHERE key IN ('ai_manual_retry','ai_processing_paused','llm_circuit') OR key GLOB 'ai_manual_retry:*'"),
    env.DB.prepare("UPDATE items SET status = 'irrelevant' WHERE status = 'queued'"),
  ]);
});

describe("AI processing controls", () => {
  it("protects pause and resume, keeps queued work while paused, and dispatches it on resume", async () => {
    const itemId = await queuedItem();
    expect((await control({ action: "pause" }, { Authorization: "" })).status).toBe(401);
    expect((await control({ action: "pause" }, { Authorization: "Basic " + btoa("settings:wrong") })).status).toBe(403);
    expect((await control({ action: "pause" }, { Origin: "https://other.example" })).status).toBe(403);
    expect((await control({ action: "pause" }, { "Content-Type": "text/plain" })).status).toBe(415);
    expect((await status()).llm.paused).toBe(false);
    expect(await (await control({ action: "pause" })).json()).toMatchObject({ status: "paused" });
    expect((await status()).llm.paused).toBe(true);
    expect((await control({ action: "retry" })).status).toBe(409);
    const fetcher = vi.fn();
    await consume(itemId, fetcher);
    expect(fetcher).not.toHaveBeenCalled();
    expect(sendBatch).not.toHaveBeenCalled();
    expect((await control({ action: "resume" })).status).toBe(202);
    expect((await status()).llm.paused).toBe(false);
    expect(sendBatch).toHaveBeenCalledExactlyOnceWith([{ body: { kind: "extract", itemId } }]);
  });

  it("retries pending items with an empty log once when two requests arrive together", async () => {
    const itemId = await queuedItem();
    expect((await log()).calls).toEqual([]);
    expect((await control({ action: "retry", model: "wrong-model" })).status).toBe(409);
    const responses = await Promise.all([control({ action: "retry", model }), control({ action: "retry" })]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 202]);
    expect(await Promise.all(responses.map((response) => response.json()))).toEqual(expect.arrayContaining([
      { status: "already_requested" }, { status: "queued", sent: 1 },
    ]));
    expect(sendBatch).toHaveBeenCalledExactlyOnceWith([{ body: { kind: "extract", itemId } }]);
    expect((await log()).calls).toEqual([]);
  });

  it("discards a valid provider response received after Stop and leaves the item available for retry", async () => {
    const itemId = await queuedItem();
    const fetcher = vi.fn(async () => {
      const [running] = (await log()).calls;
      expect(running?.status).toBe("running");
      const stop = { action: "stop_call", id: running!.id };
      expect((await control(stop)).status).toBe(200);
      expect((await control(stop)).status).toBe(200);
      return providerResponse(itemId);
    });
    const delivery = await consume(itemId, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(delivery.ack).toHaveBeenCalledTimes(1);
    const [stopped] = (await log()).calls;
    expect(stopped).toMatchObject({ status: "stopped", retryable: 1 });
    expect(await env.DB.prepare("SELECT status, enqueue_attempts FROM items WHERE id = ?").bind(itemId).first()).toEqual({ status: "queued", enqueue_attempts: 0 });
    // An explicit retry of this old batch must still run when newer items are pending.
    await env.DB.prepare("UPDATE items SET published_at = ? WHERE id = ?").bind(now - 90 * 86400, itemId).run();
    await queuedItem();
    expect((await control({ action: "retry", id: stopped!.id })).status).toBe(202);
    expect(sendBatch).toHaveBeenCalledExactlyOnceWith([{ body: { kind: "extract", itemId, operatorRetry: true } }]);
    const retryDelivery = { body: sendBatch.mock.calls[0]![0][0].body, attempts: 1, ack: vi.fn(), retry: vi.fn() };
    const retried = vi.fn(async () => providerResponse(itemId));
    await consumeLlmBatch({ messages: [retryDelivery] } as unknown as MessageBatch<LlmMessage>, testEnv, { now, fetcher: retried });
    expect(retried).toHaveBeenCalledTimes(1);
    expect((await log()).calls.find(call => call.id === stopped!.id)?.retryable).toBe(0);
  });

  it("counts actual requests past 100 in unlimited mode and preserves provider 429 cooldown", async () => {
    const itemId = await queuedItem();
    await env.DB.prepare("INSERT INTO llm_usage (day_pt, model, kind, requests) VALUES (?, ?, 'extract', 100)").bind(pacificDay(now), model).run();
    const initial = (await status()).llm;
    expect(initial.unlimited).toBe(true);
    expect(initial.models).toContainEqual(expect.objectContaining({ model, rpm: null, rpd: null }));
    const success = vi.fn(async () => providerResponse(itemId));
    await consume(itemId, success);
    expect(success).toHaveBeenCalledTimes(1);
    expect((await status()).llm.usageToday).toContainEqual(expect.objectContaining({ model, kind: "extract", requests: 101, tokensIn: 11, tokensOut: 3 }));
    const next = await queuedItem();
    const limited = vi.fn(async () => Response.json({ error: { message: "Rate limited" } }, { status: 429, headers: { "Retry-After": "120" } }));
    await consume(next, limited);
    expect((await log()).calls[0]).toMatchObject({ status: "rate_limited", httpStatus: 429 });
    expect(await (await control({ action: "retry", model })).json()).toMatchObject({ status: "cooldown", until: now + 120 });
    expect(sendBatch).not.toHaveBeenCalled();
    await consume(next, limited);
    expect(limited).toHaveBeenCalledTimes(1);
    expect((await status()).llm.usageToday).toContainEqual(expect.objectContaining({ model, kind: "extract", requests: 102 }));
  });

  it("honors provider Retry-After when the rate-limit response arrives after the operator stops the call", async () => {
    const itemId = await queuedItem();
    await consume(itemId, async () => {
      const [running] = (await log()).calls;
      expect((await control({ action: "stop_call", id: running!.id })).status).toBe(200);
      return Response.json({ error: { message: "Rate limited" } }, { status: 429, headers: { "Retry-After": "120" } });
    });
    const [stopped] = (await log()).calls;
    expect(stopped?.status).toBe("stopped");
    expect(await (await control({ action: "retry", id: stopped!.id })).json()).toMatchObject({ status: "cooldown", until: now + 120 });
    expect(sendBatch).not.toHaveBeenCalled();
  });

  it.each([
    { limit: undefined, expected: 10 }, { limit: 1, expected: 1 },
    { limit: 12, expected: 12 }, { limit: 500, expected: 500 },
  ])("retries up to $expected available items with limit $limit", async ({ limit, expected }) => {
    const ids = await queuedItems(expected + 2);
    const response = await control({ action: "retry", limit });
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ status: "queued", sent: expected });
    const messages = sendBatch.mock.calls.flatMap(([batch]) => batch as { body: LlmMessage }[]);
    for (const [batch] of sendBatch.mock.calls) expect(batch.length).toBeLessThanOrEqual(100);
    expect(messages.map(message => message.body)).toEqual(ids.slice(0, expected).map(itemId => ({ kind: "extract", itemId })));
    expect((await log()).calls).toEqual([]);
  });

  it("preserves confirmed sends and lets the scheduler recover only the rest after the second batch fails", async () => {
    const ids = await queuedItems(250);
    sendBatch.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("queue temporarily unavailable"));
    const response = await control({ action: "retry", limit: 500 });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ status: "partially_queued", sent: 100 });
    expect(sendBatch).toHaveBeenCalledTimes(2);
    const { results } = await env.DB.prepare(`SELECT id, queued_at FROM items
      WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id`).bind(JSON.stringify(ids)).all<{ id: number; queued_at: number | null }>();
    expect(results.filter(row => row.queued_at !== null).map(row => row.id)).toEqual(ids.slice(0, 100));
    expect(results.filter(row => row.queued_at === null).map(row => row.id)).toEqual(ids.slice(100));
    sendBatch.mockReset();
    expect((await drainBacklog(testEnv, now + 1)).sent).toBe(150);
    const recoveredIds = sendBatch.mock.calls.flatMap(([batch]) => (batch as { body: { itemId: number } }[]).map(message => message.body.itemId));
    expect(recoveredIds).toEqual(ids.slice(100));
  });

  it("rejects invalid retry limits before scheduling any work", async () => {
    await queuedItem();
    for (const limit of [501, 0, 1.5]) expect((await control({ action: "retry", limit })).status).toBe(400);
    expect(sendBatch).not.toHaveBeenCalled();
  });

  it("lists running and processing calls across models while excluding finished and stale attempts", async () => {
    const running = await recordCall("extract", [11, 12], "running");
    const otherModel = model + "-old";
    const processing = await insertLlmCall(env.DB, { at: now - 60, model: otherModel, kind: "synthesize", itemIds: [42], promptVersion: 1, status: "processing" });
    const ignored = await Promise.all([recordCall("extract", [1], "running", now - 901),
      recordCall("extract", [1], "processing", now - 901), recordCall("extract", [1], "ok"), recordCall("extract", [1], "stopped")]);
    const active = (await status()).llm.activeCalls;
    const live = await request("/api/status/llm-active");
    expect(live.headers.get("Cache-Control")).toBe("no-store");
    expect(await live.json()).toMatchObject({ activeCalls: active });
    expect(active).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: running, at: now, model, kind: "extract", status: "running", subjects: 2 }),
      expect.objectContaining({ id: processing, at: now - 60, model: otherModel, kind: "synthesize", status: "processing", subjects: 1 }),
    ]));
    for (const id of ignored) expect(active.some(call => call.id === id)).toBe(false);
  });

  it.each([false, true])("retries a synthesis against current membership only when needed (completed=%s)", async (completed) => {
    const story = await storyFixture(completed);
    const id = await recordCall("synthesize", [story.storyId], "stopped");
    expect((await log()).calls[0]).toMatchObject({ id, retryable: completed ? 0 : 1 });
    const response = await control({ action: "retry", id });
    expect(response.status).toBe(completed ? 200 : 202);
    expect(await response.json()).toMatchObject(completed ? { status: "no_eligible_items", sent: 0 } : { status: "queued", sent: 1 });
    if (completed) {
      expect(sendBatch).not.toHaveBeenCalled();
    } else {
      expect(sendBatch).toHaveBeenCalledExactlyOnceWith([{ body: { kind: "synthesize", ...story } }]);
      // A second consumer can finish synthesis between the manual retry and delivery.
      await env.DB.prepare("UPDATE stories SET synthesized_hash = members_hash WHERE id = ?").bind(story.storyId).run();
      const delivery = { body: sendBatch.mock.calls[0]![0][0].body, attempts: 1, ack: vi.fn(), retry: vi.fn() };
      const provider = vi.fn();
      await consumeLlmBatch({ messages: [delivery] } as unknown as MessageBatch<LlmMessage>, testEnv, { now, fetcher: provider });
      expect(provider).not.toHaveBeenCalled();
      expect(delivery.ack).toHaveBeenCalled();
    }
    expect((await log()).calls).toEqual([expect.objectContaining({ id, retryable: 0 })]);
  });

  it.each([false, true])("retries undecided adjudications from the original call (completed=%s)", async (completed) => {
    const insertEntity = (name: string) => env.DB.prepare("INSERT INTO entities (canonical_name, type, created_at) VALUES (?, 'concept', ?) RETURNING id").bind(name, now).first<number>("id");
    const candidate = await insertEntity("candidate");
    const provisional = await insertEntity("provisional");
    const adjudication = (state: string) => env.DB.prepare(`INSERT INTO entity_adjudications
      (mention_normalized, provisional_entity_id, candidate_entity_id, similarity, status) VALUES (?, ?, ?, 0.9, ?) RETURNING id`)
      .bind(crypto.randomUUID(), provisional, candidate, state).first<number>("id");
    const selected = (await adjudication(completed ? "decided" : "pending"))!;
    const decided = (await adjudication("decided"))!;
    await adjudication("pending"); // unrelated to this call
    const id = await recordCall("adjudicate", [decided, selected]);
    expect((await log()).calls[0]).toMatchObject({ id, retryable: completed ? 0 : 1 });
    const response = await control({ action: "retry", id });
    expect(response.status).toBe(completed ? 200 : 202);
    expect(await response.json()).toMatchObject(completed ? { status: "no_eligible_items", sent: 0 } : { status: "queued", sent: 1 });
    if (completed) expect(sendBatch).not.toHaveBeenCalled();
    else {
      expect(sendBatch).toHaveBeenCalledExactlyOnceWith([{ body: { kind: "adjudicate", adjudicationIds: [selected] } }]);
      await env.DB.prepare("UPDATE entity_adjudications SET status = 'decided' WHERE id = ?").bind(selected).run();
    }
    expect((await log()).calls).toEqual([expect.objectContaining({ id, retryable: 0 })]);
  });

  it("does not queue a synthesis when the story has lost all active claims", async () => {
    const { storyId } = await storyFixture(false);
    await env.DB.prepare("UPDATE story_claims SET active = 0 WHERE story_id = ?").bind(storyId).run();
    const id = await recordCall("synthesize", [storyId], "stopped");
    expect((await log()).calls[0]).toMatchObject({ id, retryable: 0 });
    const response = await control({ action: "retry", id });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "no_eligible_items", sent: 0 });
    expect(sendBatch).not.toHaveBeenCalled();
  });
});
