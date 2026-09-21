import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { upsertItem } from "../../src/db/items-repo";
import { budgetedCall, type LlmEnv } from "../../src/llm/budgeted-call";
import { consumeLlmBatch } from "../../src/llm/llm-consumer";
import type { LlmMessage } from "../../src/llm/messages";
import { itemInput, seedSource } from "../db/seed";

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
  const batch = { queue: "radar-llm", messages: [{ body: { kind: "extract", itemId: id }, attempts, ack: () => outcomes.push("ack"), retry: (o?: { delaySeconds?: number }) => outcomes.push(`retry:${o?.delaySeconds}`) }] } as unknown as MessageBatch<LlmMessage>;
  const testEnv: LlmEnv = { DB: env.DB, RAW: env.RAW, DEEPSEEK_API_KEY: apiKey, LLM_QUEUE: {} as Queue<LlmMessage> };
  await consumeLlmBatch(batch, testEnv, { now: NOW, fetcher });
  return { calls, outcomes, item: await env.DB.prepare("SELECT status, enqueue_attempts FROM items WHERE id = ?").bind(id).first() };
}

describe("provider availability does not poison queued articles", () => {
  it("routes budgeted work through Gateway BYOK with no direct provider key", async () => {
    const run = vi.fn().mockResolvedValue(Response.json({ choices: [{ finish_reason: "stop", message: { content: '{"items":[]}' } }], usage: { prompt_tokens: 15, completion_tokens: 4 } }));
    const gatewayEnv: LlmEnv = { DB: env.DB, RAW: env.RAW, LLM_QUEUE: {} as Queue<LlmMessage>, AI_GATEWAY_ID: "gateway", AI: { gateway: () => ({ run }) } };
    expect(await budgetedCall(gatewayEnv, { kind: "extract", promptVersion: 2, system: "Return JSON", user: "check", schema: {}, subjectIds: [] }, { now: NOW })).toMatchObject({ status: "ok", model: "deepseek-flash" });
    expect(run).toHaveBeenCalledOnce();
    expect(await env.DB.prepare("SELECT requests,tokens_in,tokens_out FROM llm_usage WHERE model='deepseek-flash'").first()).toEqual({ requests: 1, tokens_in: 15, tokens_out: 4 });
  });

  it("parks a missing AI binding without consuming budget or using a direct key", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const gatewayEnv: LlmEnv = { DB: env.DB, RAW: env.RAW, LLM_QUEUE: {} as Queue<LlmMessage>, AI_GATEWAY_ID: "gateway", DEEPSEEK_API_KEY: "unused-direct-key" };
    expect(await budgetedCall(gatewayEnv, { kind: "extract", promptVersion: 2, system: "Return JSON", user: "check", schema: {}, subjectIds: [] }, { now: NOW, fetcher })).toEqual({ status: "park" });
    expect(fetcher).not.toHaveBeenCalled();
    expect(await env.DB.prepare("SELECT COALESCE(SUM(requests),0) AS n FROM llm_usage").first()).toEqual({ n: 0 });
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
