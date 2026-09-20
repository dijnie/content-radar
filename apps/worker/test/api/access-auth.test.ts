import { env } from "cloudflare:workers";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTVerifyGetKey } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { verifyAccess } from "../../src/api/access-auth";
import worker from "../../src/index";

const CONFIG = {
  ACCESS_TEAM_DOMAIN: "https://radar-test.cloudflareaccess.com",
  ACCESS_AUD: "test-audience",
  OWNER_EMAIL: "owner@example.com",
};

let privateKey: CryptoKey;
let keySet: JWTVerifyGetKey;

interface TokenOptions {
  iss?: string;
  aud?: string;
  email?: string;
  exp?: string | number;
  alg?: string;
  key?: CryptoKey;
}

async function token(options: TokenOptions = {}): Promise<string> {
  return new SignJWT({ email: options.email ?? CONFIG.OWNER_EMAIL })
    .setProtectedHeader({ alg: options.alg ?? "RS256", kid: "test-key" })
    .setIssuer(options.iss ?? CONFIG.ACCESS_TEAM_DOMAIN)
    .setAudience(options.aud ?? CONFIG.ACCESS_AUD)
    .setIssuedAt()
    .setExpirationTime(options.exp ?? "5m")
    .sign(options.key ?? privateKey);
}

function request(jwt?: string): Request {
  return new Request("https://radar.example.com/", {
    headers: jwt ? { "Cf-Access-Jwt-Assertion": jwt } : {},
  });
}

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  const jwk = await exportJWK(pair.publicKey);
  keySet = createLocalJWKSet({ keys: [{ ...jwk, kid: "test-key", alg: "RS256", use: "sig" }] });
});

describe("verifyAccess", () => {
  it("accepts a valid owner token", async () => {
    const result = await verifyAccess(request(await token()), CONFIG, keySet);
    expect(result).toEqual({ ok: true, email: CONFIG.OWNER_EMAIL });
  });

  it("returns 401 without a token", async () => {
    expect(await verifyAccess(request(), CONFIG, keySet)).toMatchObject({ ok: false, status: 401 });
  });

  it("returns 403 for a wrong audience", async () => {
    const result = await verifyAccess(request(await token({ aud: "other-app" })), CONFIG, keySet);
    expect(result).toMatchObject({ ok: false, status: 403 });
  });

  it("returns 403 for a wrong issuer", async () => {
    const jwt = await token({ iss: "https://attacker.cloudflareaccess.com" });
    expect(await verifyAccess(request(jwt), CONFIG, keySet)).toMatchObject({ ok: false, status: 403 });
  });

  it("returns 403 for another email", async () => {
    const jwt = await token({ email: "intruder@example.com" });
    expect(await verifyAccess(request(jwt), CONFIG, keySet)).toMatchObject({ ok: false, status: 403 });
  });

  it("returns 403 for an expired token", async () => {
    const jwt = await token({ exp: Math.floor(Date.now() / 1000) - 60 });
    expect(await verifyAccess(request(jwt), CONFIG, keySet)).toMatchObject({ ok: false, status: 403 });
  });

  it("returns 403 for a token signed by an unknown key", async () => {
    const other = await generateKeyPair("RS256");
    const jwt = await token({ key: other.privateKey });
    expect(await verifyAccess(request(jwt), CONFIG, keySet)).toMatchObject({ ok: false, status: 403 });
  });

  it("returns 403 for an algorithm other than RS256", async () => {
    const pair = await generateKeyPair("ES256");
    const jwt = await token({ alg: "ES256", key: pair.privateKey });
    expect(await verifyAccess(request(jwt), CONFIG, keySet)).toMatchObject({ ok: false, status: 403 });
  });

  it("returns 403 for garbage", async () => {
    expect(await verifyAccess(request("not-a-jwt"), CONFIG, keySet)).toMatchObject({ ok: false, status: 403 });
  });

  it("fails closed with 503 when the key set cannot be loaded", async () => {
    const unavailable: JWTVerifyGetKey = async () => {
      throw new TypeError("fetch failed");
    };
    const result = await verifyAccess(request(await token()), CONFIG, unavailable);
    expect(result).toMatchObject({ ok: false, status: 503 });
  });

  it("answers 503 rather than crashing when nothing is configured and no key set is injected", async () => {
    const unconfigured = { ACCESS_TEAM_DOMAIN: "", ACCESS_AUD: "", OWNER_EMAIL: "" };
    expect(await verifyAccess(request(await token()), unconfigured)).toMatchObject({ ok: false, status: 503, reason: "access_not_configured" });
    const malformed = { ...CONFIG, ACCESS_TEAM_DOMAIN: "not a url" };
    expect(await verifyAccess(request(await token()), malformed)).toMatchObject({ ok: false, status: 503 });
  });

  it("fails closed with 503 when Access is not configured", async () => {
    const result = await verifyAccess(request(await token()), { ...CONFIG, ACCESS_AUD: "" }, keySet);
    expect(result).toMatchObject({ ok: false, status: 503 });
  });
});

describe("worker fetch", () => {
  it("rejects unauthenticated requests for both the API and static assets", async () => {
    for (const path of ["/", "/assets/app.js", "/api/admin/probe?target=hn-algolia"]) {
      const response = await worker.fetch(new Request(`https://radar.example.com${path}`), env);
      expect(response.status, path).toBe(401);
    }
  });
});
