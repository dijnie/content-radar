import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { upsertAuthorByHandle } from "../../src/db/authors-repo";

describe("upsertAuthorByHandle", () => {
  it("links handles on different platforms to one author through the author key", async () => {
    const onX = await upsertAuthorByHandle(env.DB, { platform: "x", handle: "@SimonW", displayName: "Simon Willison", authorKey: "simon-willison" });
    const onRss = await upsertAuthorByHandle(env.DB, { platform: "rss", handle: "simonwillison.net", authorKey: "simon-willison" });
    expect(onRss).toBe(onX);
  });

  it("is idempotent and case-insensitive for X handles", async () => {
    const first = await upsertAuthorByHandle(env.DB, { platform: "x", handle: "Karpathy" });
    const second = await upsertAuthorByHandle(env.DB, { platform: "x", handle: "karpathy", displayName: "Renamed" });
    expect(second).toBe(first);
    const row = await env.DB.prepare("SELECT canonical_name FROM authors WHERE id = ?").bind(first).first<{ canonical_name: string }>();
    expect(row?.canonical_name).toBe("karpathy");
  });

  it("never re-links a handle that already belongs to an author", async () => {
    const owner = await upsertAuthorByHandle(env.DB, { platform: "hn", handle: "pg", authorKey: "paul-graham" });
    const attempt = await upsertAuthorByHandle(env.DB, { platform: "hn", handle: "pg", authorKey: "someone-else" });
    expect(attempt).toBe(owner);
  });
});
