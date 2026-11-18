import { env } from "cloudflare:workers";
import { describe, it, expect } from "vitest";
import worker from "../../src/index";
import type { Env } from "../../src/env";
import { getAiSettings, embeddingProvider } from "../../src/db/ai-settings";
import { listEnabledModels } from "../../src/db/llm-repo";
import { circuitOpenUntil, pauseCircuit } from "../../src/llm/circuit-breaker";

const origin = "https://radar.example";
const password = "mật khẩu: " + crypto.randomUUID();
const settings = {
  revision: 0, enabled: true, chatEndpoint: "https://chat.example/v1", chatModel: "chat-1", chatKey: "test-chat-secret",
  embeddingEndpoint: "https://vectors.example/v1", embeddingModel: "embed-1", embeddingKey: "test-vector-secret",
};

async function call(supplied: string, body?: unknown, workerEnv: Env = { ...env, PASSWORD: password }) {
  const bytes = new TextEncoder().encode(`settings:${supplied}`);
  const credentials = btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(""));
  return worker.fetch(new Request(origin + "/api/settings/ai", {
    method: body ? "POST" : "GET", headers: { Authorization: supplied ? "Basic " + credentials : "", Origin: origin, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }), workerEnv);
}

describe("owner AI settings", () => {
  it("identifies a missing D1 schema after authentication", async () => {
    const db = { prepare: () => ({ first: async () => { throw new Error("D1_ERROR: no such table: ai_settings: SQLITE_ERROR"); } }) };
    const workerEnv = { ...env, PASSWORD: password, DB: db as unknown as D1Database };
    const result = await call(password, undefined, workerEnv);
    expect(result.status).toBe(503);
    expect(await result.json()).toEqual({ error: "settings_database_not_ready" });
    expect((await call("wrong", undefined, workerEnv)).status).toBe(403);
  });

  it("locks reads and writes when the Worker secret is missing and accepts only the current secret", async () => {
    const missing = { ...env };
    delete missing.PASSWORD;
    for (const body of [undefined, settings]) {
      const response = await call(password, body, missing);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "password_not_configured" });
    }
    const before = await getAiSettings(env.DB);
    const rotated = { ...env, PASSWORD: crypto.randomUUID() };
    expect((await call(password, settings, rotated)).status).toBe(403);
    expect((await call(rotated.PASSWORD, undefined, rotated)).status).toBe(200);
    expect(await getAiSettings(env.DB)).toEqual(before);
    expect((await env.DB.prepare("SELECT name FROM pragma_table_info('ai_settings') WHERE name = 'owner_token'").all()).results).toEqual([]);
  });

  it("starts paused, restricts reads and writes and never sends saved keys to the browser", async () => {
    expect((await call("")).status).toBe(401);
    expect(await listEnabledModels(env.DB)).toEqual([]);
    expect((await call("a".repeat(64))).status).toBe(403);
    expect((await call("a".repeat(64), settings)).status).toBe(403);
    await pauseCircuit(env.DB, "configuration_error", 12345);
    const saved = await call(password, settings);
    expect(saved.status).toBe(200);
    expect(await circuitOpenUntil(env.DB, 12346)).toBeNull();
    for (const res of [saved, await call(password)]) {
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      const data = await res.text();
      expect(data).not.toContain(password);
      expect(data).not.toContain("test-chat-secret");
      expect(data).not.toContain("test-vector-secret");
      expect(JSON.parse(data)).toMatchObject({ enabled: true, revision: 1, hasChatKey: true, hasEmbeddingKey: true });
    }
    expect(await listEnabledModels(env.DB)).toMatchObject([{ model: "chat-1" }]);
    expect(embeddingProvider(await getAiSettings(env.DB))).toEqual({ model: "embed-1", endpoint: settings.embeddingEndpoint, apiKey: settings.embeddingKey });
    expect((await call(password, settings)).status).toBe(409);
    const edit = { ...settings, revision: 1, chatKey: "", embeddingKey: "" };
    expect((await call(password, { ...edit, chatEndpoint: "https://other.example/v1" })).status).toBe(400);
    expect((await call(password, { ...edit, embeddingEndpoint: "https://other.example/v1" })).status).toBe(400);
    expect((await call(password, { ...edit, enabled: false, embeddingEndpoint: "", chatModel: "chat-2" })).status).toBe(200);
    expect(await listEnabledModels(env.DB)).toEqual([]);
    const row = await getAiSettings(env.DB);
    expect(row.embedding_key).toBe("");
    expect(embeddingProvider(row)).toEqual({ endpoint: settings.chatEndpoint, apiKey: settings.chatKey, model: "embed-1" });
  });

  it("rejects unsafe provider URLs without writing the revision", async () => {
    const { revision } = await getAiSettings(env.DB);
    for (const url of ["http://service.example/v1", "https://key@service.example", "https://service.example/v1?api_key=hidden", "file:///api"]) {
      expect((await call(password, { ...settings, revision, chatEndpoint: url })).status).toBe(400);
    }
    expect((await getAiSettings(env.DB)).revision).toBe(revision);
  });
});
