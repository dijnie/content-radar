import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { upsertItem } from "../../src/db/items-repo";
import type { LlmEnv } from "../../src/llm/budgeted-call";
import { consumeLlmBatch } from "../../src/llm/llm-consumer";
import type { LlmMessage } from "../../src/llm/messages";
import recorded from "../fixtures/gemini/extract-recorded-gemini-3.6-flash.json";
import envelope from "../fixtures/deepseek/success-envelope.json";
import { itemInput, seedSource } from "../db/seed";

const NOW = Date.UTC(2026, 8, 21, 6, 0, 0) / 1000;

describe("historical extraction content recorded from Gemini", () => {
  it("remains valid through the DeepSeek consumer transport without inventing a live DeepSeek recording", async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM llm_usage"), env.DB.prepare("DELETE FROM llm_calls"), env.DB.prepare("DELETE FROM settings WHERE key = 'llm_circuit'"),
      env.DB.prepare("UPDATE llm_models SET exhausted_until = NULL, rpm = 1000, rpd = 1000, enabled = CASE WHEN model = 'deepseek-flash' THEN 1 ELSE 0 END"),
      env.DB.prepare("UPDATE items SET status = 'irrelevant' WHERE status = 'queued'"),
      env.DB.prepare("INSERT INTO topics (slug, name, keywords_json) VALUES ('ai', 'AI & Agent', '[]') ON CONFLICT(slug) DO NOTHING"),
    ]);
    const sourceId = await seedSource(env.DB, "x", "recorded-gemini");
    const idOf = new Map<number, number>();
    for (const item of recorded.recorded.items) {
      const { id } = await upsertItem(env.DB, itemInput({ sourceId, externalId: `recorded-${item.itemId}`, textExcerpt: item.text, fetchedAt: NOW - 3600 }));
      idOf.set(item.itemId, id);
    }

    // The payload is historical evidence; only this transport envelope is synthetic.
    const models: string[] = [];
    const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      models.push(JSON.parse(String(init!.body)).model);
      // Only the ids differ from the recording: the database assigned its own.
      const body = structuredClone(envelope);
      const payload = JSON.parse(recorded.response.candidates[0]!.content.parts[0]!.text) as { items: { itemId: number }[] };
      for (const entry of payload.items) entry.itemId = idOf.get(entry.itemId)!;
      body.choices[0]!.message.content = JSON.stringify(payload);
      body.usage.prompt_tokens = recorded.response.usageMetadata.promptTokenCount;
      return Response.json(body);
    }) as typeof fetch;

    const outcomes: string[] = [];
    const batch = { queue: "radar-llm", messages: [...idOf.values()].map((itemId) => ({ body: { kind: "extract", itemId }, attempts: 1, ack: () => outcomes.push("ack"), retry: () => outcomes.push("retry") })) } as unknown as MessageBatch<LlmMessage>;
    const testEnv: LlmEnv = { DB: env.DB, RAW: env.RAW, LLM_ENDPOINT: "https://llm.example/v1", LLM_API_KEY: "test-key", LLM_QUEUE: { sendBatch: async () => {} } as unknown as Queue<LlmMessage> };
    await consumeLlmBatch(batch, testEnv, { now: NOW, fetcher });

    expect(models).toEqual(["deepseek-flash"]);
    expect(outcomes).toEqual(["ack", "ack", "ack"]);
    const ids = [...idOf.values()].join(",");
    expect((await env.DB.prepare(`SELECT status, COUNT(*) AS n FROM items WHERE id IN (${ids}) GROUP BY status ORDER BY status`).all()).results).toEqual([{ status: "extracted", n: 1 }, { status: "irrelevant", n: 2 }]);

    const claim = await env.DB.prepare(`SELECT c.kind, c.quote, c.text_vi, c.model, c.topics_json, i.text_excerpt FROM claims c JOIN items i ON i.id = c.item_id WHERE c.item_id IN (${ids})`).first<Record<string, string>>();
    expect(claim).toMatchObject({ kind: "report", model: "deepseek-flash", topics_json: '["ai"]' });
    expect(claim!.text_excerpt).toContain(claim!.quote);
    expect(claim!.text_vi).toContain("Simon Willison");
    const call = await env.DB.prepare("SELECT claims_returned, claims_accepted, reject_reasons_json, tokens_in FROM llm_calls WHERE status = 'ok'").first();
    expect(call).toEqual({ claims_returned: 1, claims_accepted: 1, reject_reasons_json: "{}", tokens_in: 648 });
    expect((await env.DB.prepare("SELECT status, COUNT(*) AS n FROM llm_calls GROUP BY status ORDER BY status").all()).results).toEqual([{ status: "ok", n: 1 }]);
  });
});
