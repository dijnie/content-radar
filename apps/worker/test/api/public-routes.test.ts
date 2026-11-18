import { seedAi } from "../db/seed-ai";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { ROUTES } from "../../src/api/router";
import worker from "../../src/index";

const ORIGIN = "https://radar.example.com";
const headers = { "Content-Type": "application/json", Origin: ORIGIN };
const call = (path: string, init: RequestInit = {}) => worker.fetch(new Request(`${ORIGIN}${path}`, init) as Parameters<typeof worker.fetch>[0], env);

function pathFor(pattern: RegExp): string {
  return pattern.source.replace(/^\^|\$$/g, "").replaceAll("\\/", "/").replace(/\(\?<id>[^)]*\)/, "987654").replace(/\(\?<feed>[^)]*\)/, "news").replace(/\(\?<kind>[^)]*\)/, "crawl");
}

describe("public access without Access secrets or login", () => {
  const cases = [
    ["GET", "/api/settings/ai", 401],
    ["POST", "/api/settings/ai", 401],
    ["GET", "/api/jobs", 200],
    ["GET", "/api/jobs/crawl/987654", 404],
    ["POST", "/api/jobs/crawls", 409],
    ["POST", "/api/jobs/feeds/news", 409],
    ["POST", "/api/jobs/schedules/news", 400],
    ["GET", "/api/feeds/news", 200],
    ["GET", "/api/feeds/news/detail", 400],
    ["POST", "/api/feeds/deep-dives/read", 400],
    ["GET", "/api/stories", 200],
    ["GET", "/api/stories/987654", 404],
    ["POST", "/api/stories/987654/action", 400],
    ["GET", "/api/status", 200],
    ["GET", "/api/status/llm-calls", 400],
    ["GET", "/api/admin/probe", 400],
    ["POST", "/api/admin/backfill", 400],
  ] as const;

  it("covers every public API route, including jobs and admin actions", () => {
    expect(cases.map(([method, path]) => `${method} ${path}`).sort()).toEqual(
      ROUTES.map((route) => `${route.method} ${pathFor(route.pattern)}`).sort(),
    );
  });

  it.each(cases)("%s %s reaches its handler without authentication", async (method, path, status) => {
    const response = await call(path, { method, ...(method === "POST" ? { body: "{}", headers } : {}) });
    expect(response.status).toBe(status);
  });

  it("serves the app and static assets without authentication", async () => {
    const fetchAsset = vi.fn<typeof env.ASSETS.fetch>().mockImplementation(async () => new Response("public asset"));
    for (const path of ["/", "/index.html", "/assets/index.js"]) {
      const response = await worker.fetch(new Request(`${ORIGIN}${path}`), { ...env, ASSETS: { ...env.ASSETS, fetch: fetchAsset } });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("public asset");
    }
    expect(fetchAsset).toHaveBeenCalledTimes(3);
  });

  it("lets anonymous visitors save and restore a story in the shared feed", async () => {
    const story = await env.DB.prepare("INSERT INTO stories (label_text, headline_vi, score, first_seen_at, last_claim_at, members_hash) VALUES ('Public story', 'Public story', 80, 1, 1, 'public') RETURNING id").first<{ id: number }>();
    expect(story).not.toBeNull();
    const id = story!.id;
    for (const [action, userState] of [["save", "saved"], ["restore", "inbox"]]) {
      const response = await call(`/api/stories/${id}/action`, { method: "POST", headers, body: JSON.stringify({ action }) });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ id, userState });
      expect(await env.DB.prepare("SELECT user_state FROM stories WHERE id = ?").bind(id).first()).toEqual({ user_state: userState });
    }
  });

  it("lets anonymous visitors change feed schedules with no APP_ORIGIN setup", async () => {
    const response = await call("/api/jobs/schedules/news", {
      method: "POST", headers, body: JSON.stringify({ enabled: true, intervalMinutes: 120 }),
    });
    expect(response.status).toBe(200);
    expect(await env.DB.prepare("SELECT enabled, interval_minutes FROM feed_schedules WHERE feed = 'news'").first()).toEqual({ enabled: 1, interval_minutes: 120 });
  });

  it.each(ROUTES.filter((route) => route.method === "POST").map((route) => pathFor(route.pattern)))("POST %s still rejects cross-origin writes and invalid content types", async (path) => {
    const body = { method: "POST", body: "{}" };
    expect((await call(path, { ...body, headers: { ...headers, Origin: "https://evil.example" } })).status).toBe(403);
    expect((await call(path, { ...body, headers: { ...headers, "Sec-Fetch-Site": "cross-site" } })).status).toBe(403);
    expect((await call(path, { ...body, headers: { "Content-Type": "application/json" } })).status).toBe(403);
    expect((await call(path, { ...body, headers: { ...headers, "Content-Type": "text/plain" } })).status).toBe(415);
  });

  it("keeps normal routing errors and does not add CORS headers", async () => {
    expect((await call("/api/nope")).status).toBe(404);
    expect((await call("/api/stories/abc")).status).toBe(404);
    expect((await call("/api/status", { method: "POST", body: "{}", headers })).status).toBe(405);
    const response = await call("/api/stories", { headers: { Origin: "https://evil.example" } });
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("uses server-side credentials for a public LLM probe without exposing the key", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ choices: [{ finish_reason: "stop", message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 5, completion_tokens: 4 } }));
    vi.stubGlobal("fetch", fetcher);
    try {
      await seedAi(env.DB, { endpoint: "https://custom.example/v1", model: "vendor/probe-model", apiKey: "probe-key" });
      const response = await worker.fetch(new Request(`${ORIGIN}/api/admin/probe?target=llm`), env);
      const body = await response.json();
      expect(body).toMatchObject({ target: "llm", status: 200, length: 11 });
      expect(JSON.stringify(body)).not.toContain("probe-key");
      expect(fetcher).toHaveBeenCalledWith("https://custom.example/v1/chat/completions", expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer probe-key" }) }));
      expect(JSON.parse(String(fetcher.mock.calls[0]![1]!.body))).toMatchObject({ model: "vendor/probe-model" });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
