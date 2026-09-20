import { describe, expect, it } from "vitest";
import { guardRequest } from "../../src/api/request-guard";

const ORIGIN = "https://radar.example.com";

function request(method: string, headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}/api/stories/1/save`, { method, headers });
}

describe("guardRequest", () => {
  it("lets GET and HEAD through without origin signals", () => {
    expect(guardRequest(request("GET"), ORIGIN)).toBeNull();
    expect(guardRequest(request("HEAD"), ORIGIN)).toBeNull();
  });

  it("accepts a same-origin JSON POST", () => {
    const req = request("POST", {
      "Sec-Fetch-Site": "same-origin",
      Origin: ORIGIN,
      "Content-Type": "application/json; charset=utf-8",
    });
    expect(guardRequest(req, ORIGIN)).toBeNull();
  });

  it("rejects a POST from another origin", () => {
    const req = request("POST", { Origin: "https://evil.example", "Content-Type": "application/json" });
    expect(guardRequest(req, ORIGIN)?.status).toBe(403);
  });

  it("rejects a cross-site POST even when Origin matches", () => {
    const req = request("POST", {
      "Sec-Fetch-Site": "cross-site",
      Origin: ORIGIN,
      "Content-Type": "application/json",
    });
    expect(guardRequest(req, ORIGIN)?.status).toBe(403);
  });

  it("rejects same-site subdomain requests", () => {
    const req = request("POST", { "Sec-Fetch-Site": "same-site", "Content-Type": "application/json" });
    expect(guardRequest(req, ORIGIN)?.status).toBe(403);
  });

  it("rejects a state-changing request with neither header", () => {
    expect(guardRequest(request("POST", { "Content-Type": "application/json" }), ORIGIN)?.status).toBe(403);
    expect(guardRequest(request("DELETE"), ORIGIN)?.status).toBe(403);
  });

  it("rejects an origin that only shares a prefix", () => {
    const req = request("POST", { Origin: `${ORIGIN}.evil.example`, "Content-Type": "application/json" });
    expect(guardRequest(req, ORIGIN)?.status).toBe(403);
  });

  it("requires JSON for POST", () => {
    const req = request("POST", { "Sec-Fetch-Site": "same-origin", "Content-Type": "text/plain" });
    expect(guardRequest(req, ORIGIN)?.status).toBe(415);
  });
});
