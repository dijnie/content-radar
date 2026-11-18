import { env } from "cloudflare:workers";
import { describe, it, expect } from "vitest";
import worker from "../../src/index";
import type { Env } from "../../src/env";
import { getAiSettings, embeddingProvider } from "../../src/db/ai-settings";
import { listEnabledModels } from "../../src/db/llm-repo";
import { circuitOpenUntil, pauseCircuit } from "../../src/llm/circuit-breaker";

const origin = "https://radar.example";
const token = crypto.randomUUID();
const settings = {
  revision: 0, enabled: true, chatEndpoint: "https://chat.example/v1", chatModel: "chat-1", chatKey: "test-chat-secret",
  embeddingEndpoint: "https://vectors.example/v1", embeddingModel: "embed-1", embeddingKey: "test-vector-secret",
};

async function call(supplied: string, body?: unknown, workerEnv: Env = { ...env, OWNER_TOKEN: token }) {
  return worker.fetch(new Request(origin + "/api/settings/ai", {
    method: body ? "POST" : "GET", headers: { Authorization: "Bearer " + supplied, Origin: origin, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }), workerEnv);
}

describe("owner AI settings", () => {
  it("locks reads and writes when the Worker secret is missing and accepts only the current secret", async () => {
    const missing = { ...env };
    delete missing.OWNER_TOKEN;
    for (const body of [undefined, settings]) {
      const response = await call(token, body, missing);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "owner_token_not_configured" });
    }
    const before = await getAiSettings(env.DB);
    const rotated = { ...env, OWNER_TOKEN: crypto.randomUUID() };
    expect((await call(token, settings, rotated)).status).toBe(403);
    expect((await call(rotated.OWNER_TOKEN, undefined, rotated)).status).toBe(200);
    expect(await getAiSettings(env.DB)).toEqual(before);
    expect((await env.DB.prepare("SELECT name FROM pragma_table_info('ai_settings') WHERE name = 'owner_token'").all()).results).toEqual([]);
  });

  it("starts paused, restricts reads and writes and never sends saved keys to the browser", async () => {
    expect((await call("")).status).toBe(401);
    expect(await listEnabledModels(env.DB)).toEqual([]);
    expect((await call("a".repeat(64))).status).toBe(403);
    expect((await call("a".repeat(64), settings)).status).toBe(403);
    await pauseCircuit(env.DB, "configuration_error", 12345);
    const saved = await call(token, settings);
    expect(saved.status).toBe(200);
    expect(await circuitOpenUntil(env.DB, 12346)).toBeNull();
    for (const res of [saved, await call(token)]) {
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      const data = await res.text();
      expect(data).not.toContain(token);
      expect(data).not.toContain("test-chat-secret");
      expect(data).not.toContain("test-vector-secret");
      expect(JSON.parse(data)).toMatchObject({ enabled: true, revision: 1, hasChatKey: true, hasEmbeddingKey: true });
    }
    expect(await listEnabledModels(env.DB)).toMatchObject([{ model: "chat-1" }]);
    expect(embeddingProvider(await getAiSettings(env.DB))).toEqual({ model: "embed-1", endpoint: settings.embeddingEndpoint, apiKey: settings.embeddingKey });
    expect((await call(token, settings)).status).toBe(409);
    const edit = { ...settings, revision: 1, chatKey: "", embeddingKey: "" };
    expect((await call(token, { ...edit, chatEndpoint: "https://other.example/v1" })).status).toBe(400);
    expect((await call(token, { ...edit, embeddingEndpoint: "https://other.example/v1" })).status).toBe(400);
    expect((await call(token, { ...edit, enabled: false, embeddingEndpoint: "", chatModel: "chat-2" })).status).toBe(200);
    expect(await listEnabledModels(env.DB)).toEqual([]);
    const row = await getAiSettings(env.DB);
    expect(row.embedding_key).toBe("");
    expect(embeddingProvider(row)).toEqual({ endpoint: settings.chatEndpoint, apiKey: settings.chatKey, model: "embed-1" });
  });

  it("rejects unsafe provider URLs without writing the revision", async () => {
    const { revision } = await getAiSettings(env.DB);
    for (const url of ["http://service.example/v1", "https://key@service.example", "https://service.example/v1?api_key=hidden", "file:///api"]) {
      expect((await call(token, { ...settings, revision, chatEndpoint: url })).status).toBe(400);
    }
    expect((await getAiSettings(env.DB)).revision).toBe(revision);
  });
});
