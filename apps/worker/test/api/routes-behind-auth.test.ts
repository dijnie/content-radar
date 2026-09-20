import { env } from "cloudflare:workers";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ROUTES } from "../../src/api/router";
import worker from "../../src/index";

const ORIGIN = "https://radar.example.com";
const TEAM = "https://radar-test.cloudflareaccess.com";
let jwt: string;

/** A concrete path for every route pattern in the table. */
function pathFor(pattern: RegExp): string {
  return pattern.source.replace(/^\^|\$$/g, "").replaceAll("\\/", "/").replace(/\(\?<id>[^)]*\)/, "1");
}

beforeAll(async () => {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", (async (input: RequestInfo | URL, init?: RequestInit) =>
    String(input instanceof Request ? input.url : input) === `${TEAM}/cdn-cgi/access/certs` ? Response.json({ keys: [jwk] }) : realFetch(input as RequestInfo, init)) as typeof fetch);
  jwt = await new SignJWT({ email: "owner@example.com" }).setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer(TEAM).setAudience("test-audience").setIssuedAt().setExpirationTime("5m").sign(privateKey);
});
afterAll(() => vi.unstubAllGlobals());

const call = (path: string, init: RequestInit = {}) => worker.fetch(new Request(`${ORIGIN}${path}`, init) as Parameters<typeof worker.fetch>[0], env);
const authed = (headers: Record<string, string> = {}) => ({ "Cf-Access-Jwt-Assertion": jwt, ...headers });

describe("every route sits behind Access and the CSRF guard", () => {
  const routes = ROUTES.map((route) => ({ method: route.method, path: pathFor(route.pattern) }));

  it("covers the whole route table, including both admin routes", () => {
    expect(routes.map((route) => `${route.method} ${route.path}`).sort()).toEqual([
      "GET /api/admin/probe", "GET /api/status", "GET /api/stories", "GET /api/stories/1", "POST /api/admin/backfill", "POST /api/stories/1/action",
    ]);
  });

  it.each(ROUTES.map((route) => [route.method, pathFor(route.pattern)] as const))("%s %s answers 401 without a token", async (method, path) => {
    const response = await call(path, { method, ...(method === "POST" ? { body: "{}", headers: { "Content-Type": "application/json", Origin: ORIGIN } } : {}) });
    expect(response.status).toBe(401);
  });

  it("answers 401 for static assets and unknown API paths without a token", async () => {
    for (const path of ["/", "/index.html", "/assets/index.js", "/api/nope", "/api/stories/1/action"]) expect((await call(path)).status, path).toBe(401);
  });

  it.each(ROUTES.filter((route) => route.method === "POST").map((route) => pathFor(route.pattern)))("POST %s from another origin is refused even with a valid token", async (path) => {
    const body = { method: "POST", body: JSON.stringify({ action: "save", handle: "simonw", days: 1 }) };
    expect((await call(path, { ...body, headers: authed({ "Content-Type": "application/json", Origin: "https://evil.example" }) })).status).toBe(403);
    expect((await call(path, { ...body, headers: authed({ "Content-Type": "application/json", "Sec-Fetch-Site": "cross-site" }) })).status).toBe(403);
    expect((await call(path, { ...body, headers: authed({ "Content-Type": "application/json" }) })).status).toBe(403);
    expect((await call(path, { ...body, headers: authed({ "Content-Type": "text/plain", Origin: ORIGIN }) })).status).toBe(415);
  });

  it("lets the owner through: GET routes answer, unknown paths are 404, wrong methods are 405", async () => {
    expect((await call("/api/stories", { headers: authed() })).status).toBe(200);
    expect((await call("/api/status", { headers: authed() })).status).toBe(200);
    expect((await call("/api/admin/probe?target=nope", { headers: authed() })).status).toBe(400);
    expect((await call("/api/nope", { headers: authed() })).status).toBe(404);
    expect((await call("/api/stories/abc", { headers: authed() })).status).toBe(404);
    const wrongMethod = await call("/api/status", { method: "POST", body: "{}", headers: authed({ "Content-Type": "application/json", Origin: ORIGIN, "Sec-Fetch-Site": "same-origin" }) });
    expect(wrongMethod.status).toBe(405);
  });

  it("sends no CORS headers", async () => {
    const response = await call("/api/stories", { headers: authed({ Origin: "https://evil.example" }) });
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});
