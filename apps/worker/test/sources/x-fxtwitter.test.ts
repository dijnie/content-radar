import { describe, expect, it } from "vitest";
import feedXml from "../fixtures/x/feed-simonw.xml?raw";
import statusJson from "../fixtures/x/status-simonw.json?raw";
import syndicationJson from "../fixtures/x/syndication-simonw.json?raw";
import timelineJson from "../fixtures/x/timeline-simonw.json?raw";
import { HttpError } from "../../src/sources/http-client";
import { mapTimeline, syndicationToken, timelineUrl, xAdapter } from "../../src/sources/x-fxtwitter";
import { fakeContext, sourceRow } from "./adapter-context";

const TIMELINE = "https://api.fxtwitter.com/2/profile/simonw/statuses";

describe("mapTimeline on a recorded timeline", () => {
  const result = mapTimeline(JSON.parse(timelineJson));
  const byKind = (kind: string) => result.items.filter((item) => item.kind === kind);

  it("maps every status and classifies posts, replies, reposts and quotes", () => {
    expect(result.items).toHaveLength(20);
    expect({ post: byKind("post").length, reply: byKind("reply").length, repost: byKind("repost").length, quote: byKind("quote").length }).toEqual({
      post: 6, reply: 5, repost: 6, quote: 3,
    });
    expect(result.cursor).toMatchObject({ bottom: expect.any(String) });
  });

  it("keeps a repost as a relation owned by the reposter, without engagement", () => {
    const repost = byKind("repost")[0]!;
    expect(repost.author?.handle).toBe("simonw");
    expect(repost.externalId).toBe(`${repost.parentExternalId}:rt:simonw`);
    expect(repost.url).toContain("/status/");
    expect(result.metrics.some((metric) => metric.externalId === repost.externalId)).toBe(false);
  });

  it("records the parent of replies and quotes, and who a reply answers", () => {
    const reply = byKind("reply")[0]!;
    expect(reply.parentExternalId).toMatch(/^\d+$/);
    expect(reply.replyToHandle).toBeTruthy();
    const quote = byKind("quote")[0]!;
    expect(quote.parentExternalId).toMatch(/^\d+$/);
    expect(quote.links.some((link) => link.includes(`/status/${quote.parentExternalId}`))).toBe(true);
  });

  it("captures engagement and expanded links instead of t.co", () => {
    const first = result.metrics.find((metric) => metric.externalId === "2101028280673656854");
    expect(first).toMatchObject({ likes: 3863, reposts: 180, replies: 204, quotes: 39, bookmarks: 292, views: 147405 });
    const links = result.items.flatMap((item) => item.links);
    expect(links.length).toBeGreaterThan(0);
    expect(links.every((link) => !link.includes("t.co/"))).toBe(true);
  });
});

describe("handle validation", () => {
  it.each(["../../admin", "simonw/../x", "a".repeat(16), "", "simon w", "simonw?x=1", "simonw@evil.example"])("rejects %j", (handle) => {
    expect(() => timelineUrl(handle)).toThrow(HttpError);
  });

  it("builds URLs that stay on api.fxtwitter.com", () => {
    expect(timelineUrl("simonw", "abc").toString()).toBe(`${TIMELINE}?cursor=abc`);
  });

  it("never issues a request for an invalid handle", async () => {
    const { ctx, requests } = fakeContext({});
    await expect(xAdapter.poll(sourceRow("x", "../admin"), ctx)).rejects.toMatchObject({ reason: "invalid_handle" });
    expect(requests).toEqual([]);
  });
});

describe("fallback chain", () => {
  it("uses the timeline API when it works", async () => {
    const { ctx, requests } = fakeContext({ [TIMELINE]: timelineJson });
    const result = await xAdapter.poll(sourceRow("x", "simonw"), ctx);
    expect(result.items).toHaveLength(20);
    expect(requests).toHaveLength(1);
  });

  it("falls back to the feed plus the status API", async () => {
    const { ctx } = fakeContext({
      [TIMELINE]: { status: 503 },
      "https://fxtwitter.com/simonw/feed.xml": feedXml,
      "https://api.fxtwitter.com/simonw/status/2101028280673656854": statusJson,
    });
    const result = await xAdapter.poll(sourceRow("x", "simonw"), ctx);
    const viaStatus = result.items.find((item) => item.externalId === "2101028280673656854");
    expect(viaStatus?.text.length).toBeGreaterThan(20);
    expect(result.metrics.find((metric) => metric.externalId === "2101028280673656854")).toMatchObject({ likes: 3863, reposts: 180 });
  });

  it("falls back to Syndication for likes and replies when the status API also fails", async () => {
    const id = "2101028280673656854";
    const { ctx } = fakeContext({
      [TIMELINE]: { status: 503 },
      "https://fxtwitter.com/simonw/feed.xml": feedXml,
      [`https://cdn.syndication.twimg.com/tweet-result?id=${id}&token=${syndicationToken(id)}`]: syndicationJson,
    });
    const result = await xAdapter.poll(sourceRow("x", "simonw"), ctx);
    expect(result.items.some((item) => item.externalId === id)).toBe(true);
    expect(result.metrics.find((metric) => metric.externalId === id)).toEqual({ externalId: id, likes: 3863, replies: 204 });
  });

  it("does not fall back when the account is gone", async () => {
    const { ctx, requests } = fakeContext({ [TIMELINE]: { status: 404 } });
    await expect(xAdapter.poll(sourceRow("x", "simonw"), ctx)).rejects.toMatchObject({ kind: "not_found" });
    expect(requests).toHaveLength(1);
  });
});
