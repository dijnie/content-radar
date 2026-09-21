import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { upsertItem } from "../../src/db/items-repo";
import type { LlmEnv } from "../../src/llm/budgeted-call";
import { generateJson, parseQuota } from "../../src/llm/gemini-client";
import { consumeLlmBatch } from "../../src/llm/llm-consumer";
import type { LlmMessage } from "../../src/llm/messages";
import { nextPacificMidnight } from "../../src/llm/pacific-day";
import recorded429 from "../fixtures/gemini/rate-limited-429-recorded.json";
import envelope from "../fixtures/gemini/success-envelope.json";
import { itemInput, seedSource } from "../db/seed";

const NOW = Date.UTC(2026, 8, 21, 6, 0, 0) / 1000;
const perMinute429 = {
  error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "You exceeded your current quota.", details: [
    { "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaId: "GenerateRequestsPerMinutePerProjectPerModel-FreeTier", quotaValue: "5" }] },
    { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "23s" },
  ] },
};
let seq = 0;

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM llm_usage"), env.DB.prepare("DELETE FROM llm_calls"), env.DB.prepare("DELETE FROM settings WHERE key = 'llm_circuit'"),
    env.DB.prepare("UPDATE llm_models SET exhausted_until = NULL, rpm = NULL, rpd = NULL, enabled = 1"),
    env.DB.prepare("UPDATE items SET status = 'irrelevant' WHERE status = 'queued'"),
    env.DB.prepare("INSERT INTO topics (slug, name, keywords_json) VALUES ('ai', 'AI & Agent', '[]') ON CONFLICT(slug) DO NOTHING"),
  ]);
});

async function runOneItem(replyFor: (model: string) => { status: number; body: unknown } | null) {
  const sourceId = await seedSource(env.DB, "x", `quota-scope-${++seq}`);
  const { id } = await upsertItem(env.DB, itemInput({ sourceId, externalId: `quota-${seq}`, textExcerpt: "Our team measured that latency dropped 40% on the internal benchmark after the rewrite.", fetchedAt: NOW - 3600 }));
  const models: string[] = [];
  const fetcher = (async (input: RequestInfo | URL) => {
    const model = /models\/([^:]+):/.exec(String(input))![1]!;
    models.push(model);
    const reply = replyFor(model);
    if (reply) return Response.json(reply.body, { status: reply.status });
    const body = structuredClone(envelope) as typeof envelope;
    body.candidates[0]!.content.parts[0]!.text = JSON.stringify({ items: [{ itemId: id, relevant: false, topics: [], claims: [] }] });
    return Response.json(body);
  }) as typeof fetch;
  const outcomes: string[] = [];
  const batch = { queue: "radar-llm", messages: [{ body: { kind: "extract", itemId: id }, attempts: 1, ack: () => outcomes.push("ack"), retry: (o?: { delaySeconds?: number }) => outcomes.push(`retry:${o?.delaySeconds}`) }] } as unknown as MessageBatch<LlmMessage>;
  const testEnv: LlmEnv = { DB: env.DB, RAW: env.RAW, GEMINI_API_KEY: "k", LLM_QUEUE: { sendBatch: async () => {} } as unknown as Queue<LlmMessage> };
  await consumeLlmBatch(batch, testEnv, { now: NOW, fetcher });
  return { models, outcomes };
}
const modelRow = (model: string) => env.DB.prepare("SELECT rpm, rpd, exhausted_until FROM llm_models WHERE model = ?").bind(model).first<{ rpm: number | null; rpd: number | null; exhausted_until: number | null }>();

describe("parseQuota", () => {
  it("reads the scope, the limit and the retry delay from a recorded 429", () => {
    expect(parseQuota(recorded429.response)).toEqual({ scope: "day", limit: 20, retryDelaySeconds: expect.any(Number) });
    expect(parseQuota(perMinute429)).toEqual({ scope: "minute", limit: 5, retryDelaySeconds: 23 });
    expect(parseQuota({ error: { code: 429, message: "slow down" } })).toEqual({ scope: "unknown", limit: null, retryDelaySeconds: null });
  });

  it("is attached to a rate-limited result", async () => {
    const result = await generateJson({ apiKey: "k", model: "m", system: "s", user: "u", schema: {}, fetcher: (async () => Response.json(recorded429.response, { status: 429 })) as typeof fetch });
    expect(result).toMatchObject({ ok: false, kind: "rate_limited", reached: true, quota: { scope: "day", limit: 20 } });
  });
});

describe("a 429 parks a model for as long as its quota says", () => {
  it("per-minute: parked for the retry delay only, the limit is learned, and the chain moves on", async () => {
    const { models, outcomes } = await runOneItem((model) => (model === "gemini-3.8-flash" ? { status: 429, body: perMinute429 } : null));
    expect(models).toEqual(["gemini-3.8-flash", "gemini-3.7-flash"]);
    expect(outcomes).toEqual(["ack"]);
    expect(await modelRow("gemini-3.8-flash")).toEqual({ rpm: 5, rpd: null, exhausted_until: NOW + 23 });
  });

  it("per-day: parked until the next Pacific midnight and the real daily limit replaces the guess", async () => {
    await runOneItem((model) => (model === "gemini-3.8-flash" ? { status: 429, body: recorded429.response } : null));
    expect(await modelRow("gemini-3.8-flash")).toEqual({ rpm: null, rpd: 20, exhausted_until: nextPacificMidnight(NOW) });
  });

  it("when every model is only minute-limited, the batch waits seconds instead of being parked for the day", async () => {
    const { outcomes } = await runOneItem(() => ({ status: 429, body: perMinute429 }));
    expect(outcomes).toEqual(["retry:60"]);
    const next = await runOneItem(() => null);
    // Still inside the 23-second park: no model is asked, and the wait stays short.
    expect(next.models).toEqual([]);
    expect(next.outcomes).toEqual(["retry:60"]);
  });
});
