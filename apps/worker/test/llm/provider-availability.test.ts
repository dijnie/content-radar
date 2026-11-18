import { seedAi } from "../db/seed-ai";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { upsertItem } from "../../src/db/items-repo";
import { budgetedCall, type LlmEnv } from "../../src/llm/budgeted-call";
import { consumeLlmBatch } from "../../src/llm/llm-consumer";
import type { LlmMessage } from "../../src/llm/messages";
import { itemInput, seedSource } from "../db/seed";
import { drainBacklog } from "../../src/llm/drain-backlog";
import { listEnabledModels } from "../../src/db/llm-repo";

const NOW = Date.UTC(2026, 8, 21, 8) / 1000;
let sequence = 0;
beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM llm_usage"), env.DB.prepare("DELETE FROM llm_calls"), env.DB.prepare("DELETE FROM settings WHERE key = 'llm_circuit'"),
    env.DB.prepare("UPDATE llm_models SET enabled = CASE WHEN model = 'deepseek-flash' THEN 1 ELSE 0 END, rpm = 5, rpd = 100, exhausted_until = NULL"),
  ]);
});

async function run(status: number, apiKey = "test-key", attempts = 1) {
  const sourceId = await seedSource(env.DB, "x", `availability-${++sequence}`);
  const { id } = await upsertItem(env.DB, itemInput({ sourceId, externalId: `availability-${sequence}`, textExcerpt: "Our team measured that latency dropped 40% on the internal benchmark after the rewrite.", fetchedAt: NOW - 3600 }));
  let calls = 0;
  const fetcher = (async () => { calls++; return new Response(status === 200 ? '{}' : "", { status, headers: { "Retry-After": "23" } }); }) as typeof fetch;
  const outcomes: string[] = [];
  const batch = { queue: "content-radar-llm", messages: [{ body: { kind: "extract", itemId: id }, attempts, ack: () => outcomes.push("ack"), retry: (o?: { delaySeconds?: number }) => outcomes.push(`retry:${o?.delaySeconds}`) }] } as unknown as MessageBatch<LlmMessage>;
  await seedAi(env.DB, { apiKey });
  const testEnv: LlmEnv = { DB: env.DB, RAW: env.RAW, LLM_QUEUE: {} as Queue<LlmMessage> };
  await consumeLlmBatch(batch, testEnv, { now: NOW, fetcher });
  return { calls, outcomes, item: await env.DB.prepare("SELECT status, enqueue_attempts FROM items WHERE id = ?").bind(id).first() };
}

describe("provider availability does not poison queued articles", () => {
  it("routes and accounts custom models without sending legacy model names", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ choices: [{ finish_reason: "stop", message: { content: '{"items":[]}' } }], usage: { prompt_tokens: 15, completion_tokens: 4 } }));
    const model = "vendor/custom-model";
    await seedAi(env.DB, { endpoint: "https://custom.example/v1", apiKey: "custom-key", model });
    const customEnv: LlmEnv = { DB: env.DB, RAW: env.RAW, LLM_QUEUE: {} as Queue<LlmMessage> };
    const request = { kind: "extract" as const, promptVersion: 2, system: "Return JSON", user: "check", schema: {}, subjectIds: [] };
    expect(await budgetedCall(customEnv, request, { now: NOW, fetcher })).toMatchObject({ status: "ok", model: "vendor/custom-model" });
    expect(fetcher).toHaveBeenCalledWith("https://custom.example/v1/chat/completions", expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer custom-key" }) }));
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]!.body))).toMatchObject({ model: "vendor/custom-model" });
    expect(await env.DB.prepare("SELECT model,requests,tokens_in,tokens_out FROM llm_usage").first()).toEqual({ model: "vendor/custom-model", requests: 1, tokens_in: 15, tokens_out: 4 });
    await env.DB.prepare("UPDATE llm_models SET rpm = 3, rpd = 50, exhausted_until = ? WHERE model = ?").bind(NOW + 23, model).run();
    expect(await budgetedCall(customEnv, request, { now: NOW, fetcher })).toEqual({ status: "retry", delaySeconds: 60 });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(await env.DB.prepare("SELECT rpm,rpd,exhausted_until FROM llm_models WHERE model = ?").bind(model).first()).toEqual({ rpm: 3, rpd: 50, exhausted_until: NOW + 23 });
  });

  it.each([{ endpoint: "" }, { model: "" }])("parks incomplete custom configuration without consuming budget: %j", async (override) => {
    const fetcher = vi.fn<typeof fetch>();
    await seedAi(env.DB, { model: "deepseek-flash", ...override });
    const customEnv: LlmEnv = { DB: env.DB, RAW: env.RAW, LLM_QUEUE: {} as Queue<LlmMessage> };
    expect(await budgetedCall(customEnv, { kind: "extract", promptVersion: 2, system: "Return JSON", user: "check", schema: {}, subjectIds: [] }, { now: NOW, fetcher })).toEqual({ status: "park" });
    expect(fetcher).not.toHaveBeenCalled();
    expect(await env.DB.prepare("SELECT COALESCE(SUM(requests),0) AS n FROM llm_usage").first()).toEqual({ n: 0 });
  });

  it.each([429, 503])("does not fall back to legacy models when the configured model returns %i", async (status) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("", { status }));
    const model = `vendor/unavailable-${status}`;
    await seedAi(env.DB, { endpoint: "https://custom.example/v1", apiKey: "test-key", model });
    const customEnv: LlmEnv = { DB: env.DB, RAW: env.RAW, LLM_QUEUE: {} as Queue<LlmMessage> };
    expect(await budgetedCall(customEnv, { kind: "extract", promptVersion: 2, system: "Return JSON", user: "check", schema: {}, subjectIds: [] }, { now: NOW, fetcher })).toMatchObject({ status: "retry" });
    expect(fetcher).toHaveBeenCalledOnce();
    expect((await env.DB.prepare("SELECT model, requests FROM llm_usage").all()).results).toEqual([{ model: model, requests: 1 }]);
  });

  it("plans backlog against the configured model's budget, preserving disabled models and usage", async () => {
    await env.DB.prepare("UPDATE settings SET value_json = 'false' WHERE key = 'llm_unlimited'").run();
    const model = "vendor/backlog-model";
    await seedAi(env.DB, { model });
    await listEnabledModels(env.DB, model);
    await env.DB.prepare("INSERT INTO llm_usage (day_pt, model, kind, requests) VALUES ('2026-09-21', ?, 'extract', 80)").bind(model).run();
    const sourceId = await seedSource(env.DB, "x", `custom-backlog-${++sequence}`);
    await upsertItem(env.DB, itemInput({ sourceId, externalId: `backlog-${sequence}`, fetchedAt: NOW - 3600, publishedAt: NOW - 3600 }));
    const sendBatch = vi.fn().mockResolvedValue(undefined);
    const queue = { sendBatch } as unknown as Queue<LlmMessage>;
    expect(await drainBacklog({ DB: env.DB, LLM_QUEUE: queue }, NOW)).toMatchObject({ sent: 0 });
    expect(sendBatch).not.toHaveBeenCalled();
    await env.DB.prepare("UPDATE llm_models SET enabled = 0 WHERE model = ?").bind(model).run();
    await seedAi(env.DB, { model });
    expect(await listEnabledModels(env.DB, model)).toEqual([]);
    expect(await env.DB.prepare("SELECT requests FROM llm_usage WHERE model = ?").bind(model).first()).toEqual({ requests: 80 });
  });

  it("429 parks only for Retry-After and preserves the owner-approved application caps", async () => {
    expect(await run(429)).toMatchObject({ calls: 1, outcomes: ["retry:60"], item: { status: "queued", enqueue_attempts: 0 } });
    expect(await env.DB.prepare("SELECT rpm, rpd, exhausted_until FROM llm_models WHERE model = 'deepseek-flash'").first()).toEqual({ rpm: 5, rpd: 100, exhausted_until: NOW + 23 });
    expect(await run(200)).toMatchObject({ calls: 0, outcomes: ["retry:60"] });
  });

  it.each([401, 402])("HTTP %i pauses the pipeline and preserves items even on the last delivery", async (status) => {
    expect(await run(status, "test-key", 6)).toMatchObject({ calls: 1, outcomes: ["ack"], item: { status: "queued", enqueue_attempts: 0 } });
    const circuit = await env.DB.prepare("SELECT value_json FROM settings WHERE key = 'llm_circuit'").first<{ value_json: string }>();
    expect(JSON.parse(circuit!.value_json)).toMatchObject({ openUntil: NOW + 900 });
    expect(await run(200)).toMatchObject({ calls: 0, outcomes: ["ack"] });
  });

  it("a missing key parks without consuming a request slot", async () => {
    expect(await run(200, "")).toMatchObject({ calls: 0, outcomes: ["ack"], item: { status: "queued", enqueue_attempts: 0 } });
    expect(await env.DB.prepare("SELECT COALESCE(SUM(requests),0) AS n FROM llm_usage").first()).toEqual({ n: 0 });
  });

  it("invalid provider output retries then parks before dead-lettering an article", async () => {
    expect(await run(200)).toMatchObject({ calls: 1, outcomes: ["retry:30"], item: { status: "queued", enqueue_attempts: 0 } });
    expect(await run(200, "test-key", 6)).toMatchObject({ calls: 1, outcomes: ["ack"], item: { status: "queued", enqueue_attempts: 0 } });
  });
});
