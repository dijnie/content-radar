import { describe, expect, it } from "vitest";
import { guardRequest } from "../../src/api/request-guard";

const ORIGIN = "https://radar.example.com";

function request(method: string, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}/api/stories/1/save`, { method, headers });
}

describe("guardRequest", () => {
  it("lets GET and HEAD through without origin signals", () => {
    expect(guardRequest(request("GET"))).toBeNull();
    expect(guardRequest(request("HEAD"))).toBeNull();
  });

  it("accepts a same-origin JSON POST", () => {
    const req = request("POST", {
      "Sec-Fetch-Site": "same-origin",
      Origin: ORIGIN,
      "Content-Type": "application/json; charset=utf-8",
    });
    expect(guardRequest(req)).toBeNull();
  });

  it("uses the actual request origin for custom domains and local development", () => {
    for (const origin of ["https://content-radar.example.workers.dev", "https://custom.example.com", "http://localhost:8787"]) {
      const req = new Request(`${origin}/api/stories/1/action`, {
        method: "POST", headers: { Origin: origin, "Content-Type": "application/json" },
      });
      expect(guardRequest(req)).toBeNull();
    }
  });

  it("rejects a POST from another origin", () => {
    const req = request("POST", { Origin: "https://evil.example", "Content-Type": "application/json" });
    expect(guardRequest(req)?.status).toBe(403);
  });

  it("rejects a cross-site POST even when Origin matches", () => {
    const req = request("POST", {
      "Sec-Fetch-Site": "cross-site",
      Origin: ORIGIN,
      "Content-Type": "application/json",
    });
    expect(guardRequest(req)?.status).toBe(403);
  });

  it("rejects same-site subdomain requests", () => {
    const req = request("POST", { "Sec-Fetch-Site": "same-site", "Content-Type": "application/json" });
    expect(guardRequest(req)?.status).toBe(403);
  });

  it("rejects a state-changing request with neither header", () => {
    expect(guardRequest(request("POST", { "Content-Type": "application/json" }))?.status).toBe(403);
    expect(guardRequest(request("DELETE"))?.status).toBe(403);
  });

  it("rejects an origin that only shares a prefix", () => {
    const req = request("POST", { Origin: `${ORIGIN}.evil.example`, "Content-Type": "application/json" });
    expect(guardRequest(req)?.status).toBe(403);
  });

  it("requires JSON for POST", () => {
    const req = request("POST", { "Sec-Fetch-Site": "same-origin", "Content-Type": "text/plain" });
    expect(guardRequest(req)?.status).toBe(415);
  });
});
