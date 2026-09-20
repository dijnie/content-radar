import { describe, expect, it } from "vitest";
import { checkOutboundUrl } from "../../src/sources/url-guard";

const OWN = ["radar.example.com"];

describe("checkOutboundUrl", () => {
  it.each([
    "https://simonwillison.net/atom/everything/",
    "http://example.com/post?id=1",
    "https://8.8.8.8/",
  ])("allows %s", (url) => {
    expect(checkOutboundUrl(url, OWN).ok).toBe(true);
  });

  it.each([
    ["file:///etc/passwd", "scheme_not_allowed"],
    ["ftp://example.com/", "scheme_not_allowed"],
    ["javascript:alert(1)", "scheme_not_allowed"],
    ["not a url", "invalid_url"],
    ["https://user:pass@example.com/", "credentials_in_url"],
    ["http://127.0.0.1/", "internal_address"],
    ["http://127.1/", "internal_address"],
    ["http://2130706433/", "internal_address"],
    ["http://0x7f.0.0.1/", "internal_address"],
    ["http://0.0.0.0/", "internal_address"],
    ["http://10.1.2.3/", "internal_address"],
    ["http://172.16.0.1/", "internal_address"],
    ["http://172.31.255.255/", "internal_address"],
    ["http://192.168.1.1/", "internal_address"],
    ["http://169.254.169.254/latest/meta-data/", "internal_address"],
    ["http://100.64.0.1/", "internal_address"],
    ["http://[::1]/", "ipv6_literal"],
    ["http://[fe80::1]/", "ipv6_literal"],
    ["http://[::ffff:127.0.0.1]/", "ipv6_literal"],
    ["http://localhost:8787/", "dotless_host"],
    ["http://intranet/", "dotless_host"],
    ["http://app.localhost/", "internal_address"],
    ["http://db.internal/", "internal_address"],
    ["https://content-radar.someone.workers.dev/", "workers_dev"],
    ["https://radar.example.com/api/admin/probe", "own_host"],
    ["https://RADAR.example.com./", "own_host"],
  ])("blocks %s as %s", (url, reason) => {
    expect(checkOutboundUrl(url, OWN)).toEqual({ ok: false, reason });
  });

  it("does not block a public address that merely resembles a private range", () => {
    expect(checkOutboundUrl("http://172.32.0.1/").ok).toBe(true);
    expect(checkOutboundUrl("http://11.0.0.1/").ok).toBe(true);
  });
});
