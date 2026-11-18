import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { upsertItem } from "../../src/db/items-repo";
import worker from "../../src/index";
import { consumeLlmBatch } from "../../src/llm/llm-consumer";
import type { LlmMessage } from "../../src/llm/messages";
import { pacificDay } from "../../src/llm/pacific-day";
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
  calls: { id: number; status: string; httpStatus: number | null }[];
};
const status = async () => (await (await request("/api/status")).json()) as { llm: {
  unlimited: boolean; paused: boolean; models: { model: string; rpm: number | null; rpd: number | null }[];
  usageToday: { model: string; kind: string; requests: number }[];
} };

async function queuedItem() {
  const key = crypto.randomUUID();
  const sourceId = await seedSource(env.DB, "x", key);
  const { id } = await upsertItem(env.DB, itemInput({ sourceId, externalId: key, publishedAt: now, fetchedAt: now }));
  return id;
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

beforeEach(async () => {
  sendBatch.mockReset();
  await seedAi(env.DB, { model });
  await env.DB.batch([
    env.DB.prepare("DELETE FROM llm_calls WHERE model = ?").bind(model),
    env.DB.prepare("DELETE FROM llm_usage WHERE model = ?").bind(model),
    env.DB.prepare("UPDATE llm_models SET exhausted_until = NULL WHERE model = ?").bind(model),
    env.DB.prepare("DELETE FROM settings WHERE key IN ('ai_manual_retry','ai_processing_paused','llm_circuit')"),
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
    expect(stopped?.status).toBe("stopped");
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
});
