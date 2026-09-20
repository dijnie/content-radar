import { describe, expect, it } from "vitest";
import releasesAtom from "../fixtures/github/releases-vllm.atom?raw";
import searchJson from "../fixtures/github/search-llm.json?raw";
import commentJson from "../fixtures/hn/item-comment.json?raw";
import storyJson from "../fixtures/hn/item-story.json?raw";
import hnSearchJson from "../fixtures/hn/search-llm.json?raw";
import atomSimon from "../fixtures/rss/atom-simonwillison.xml?raw";
import rssOpenai from "../fixtures/rss/rss-openai.xml?raw";
import { extractArticleText } from "../../src/sources/article-text";
import { githubAdapter } from "../../src/sources/github";
import { hnAdapter, mapComment } from "../../src/sources/hacker-news";
import { rssAdapter } from "../../src/sources/rss-feed";
import { fakeContext, sourceRow } from "./adapter-context";

const HN_SEARCH = "https://hn.algolia.com/api/v1/search_by_date?query=LLM&tags=story&numericFilters=points%3E20&hitsPerPage=20";

describe("hnAdapter", () => {
  it("maps recorded stories with their target URL and points", async () => {
    const { ctx } = fakeContext({ [HN_SEARCH]: hnSearchJson });
    const result = await hnAdapter.poll(sourceRow("hn", "LLM"), ctx);
    expect(result.items).toHaveLength(5);
    const story = result.items.find((item) => item.externalId === "49776699")!;
    expect(story).toMatchObject({ kind: "story", url: "https://news.ycombinator.com/item?id=49776699", links: ["https://pirateface.co"] });
    expect(story.author).toMatchObject({ platform: "hn", handle: "skepticalgenius" });
    expect(result.metrics.find((metric) => metric.externalId === "49776699")).toMatchObject({ points: 95, comments: 24 });
  });

  it("takes comments of a hot story in HN's own ranking order, not by length", async () => {
    const hot = JSON.parse(hnSearchJson);
    hot.hits = [{ ...hot.hits[0], points: 250 }];
    const story = JSON.parse(storyJson);
    const kids: number[] = story.kids;
    const routes: Record<string, string> = {
      [HN_SEARCH]: JSON.stringify(hot),
      "https://hacker-news.firebaseio.com/v0/item/49776699.json": storyJson,
    };
    kids.forEach((kid, index) => {
      // Later comments are much longer; ranking must still win.
      const text = index === 0 ? JSON.parse(commentJson).text : `comment ${index} ${"long ".repeat(index * 200)}`;
      routes[`https://hacker-news.firebaseio.com/v0/item/${kid}.json`] = JSON.stringify({ id: kid, type: "comment", by: `user${index}`, time: 1789920593, text, parent: 49776699 });
    });
    const { ctx } = fakeContext(routes);
    const result = await hnAdapter.poll(sourceRow("hn", "LLM"), ctx);
    const comments = result.items.filter((item) => item.kind === "comment");
    expect(comments.map((comment) => comment.externalId)).toEqual(kids.slice(0, 10).map(String));
    expect(comments.every((comment) => comment.parentExternalId === "49776699")).toBe(true);
  });

  it("drops dead, deleted and empty comments and strips markup and control characters", () => {
    expect(mapComment({ id: 1, type: "comment", by: "a", text: "x", dead: true }, "9")).toBeNull();
    expect(mapComment({ id: 1, type: "comment", deleted: true }, "9")).toBeNull();
    const mapped = mapComment({ id: 2, type: "comment", by: "a", time: 5, text: "<p>Hi\u0000 <i>there</i>‮</p><script>x</script>" }, "9");
    expect(mapped?.text).toBe("Hi there");
  });
});

describe("rssAdapter", () => {
  const FEED = "https://simonwillison.net/atom/everything/";

  it("scopes external ids to the source and links the feed host as the author handle", async () => {
    const { ctx } = fakeContext({ [FEED]: atomSimon });
    const a = await rssAdapter.poll(sourceRow("rss", FEED, 11), ctx);
    const b = await rssAdapter.poll(sourceRow("rss", FEED, 12), fakeContext({ [FEED]: atomSimon }).ctx);
    expect(a.items).toHaveLength(4);
    expect(a.items[0]!.externalId).toMatch(/^11:[0-9a-f]{64}$/);
    expect(b.items[0]!.externalId).toMatch(/^12:[0-9a-f]{64}$/);
    expect(a.items[0]).toMatchObject({ kind: "article", title: "datasette-auth-github 1.0", author: { platform: "rss", handle: "simonwillison.net" } });
    expect(a.items[0]!.links).toContain("https://github.com/simonw/datasette-auth-github/releases/tag/1.0");
  });

  it("fetches the article for summary-only feeds, within the per-poll budget", async () => {
    const feedUrl = "https://openai.com/news/rss.xml";
    const article = `<html><body><nav><p>Menu item</p></nav><article><h1>Blueprint</h1>${"<p>Real paragraph of the article body with enough words to count.</p>".repeat(12)}</article><footer><p>Footer</p></footer></body></html>`;
    const routes = Object.fromEntries(
      [...rssOpenai.matchAll(/<link>(https:\/\/openai\.com\/index\/[^<]+)<\/link>/g)].map((match) => [match[1]!, { status: 200, body: article, contentType: "text/html" }]),
    );
    const { ctx, requests } = fakeContext({ [feedUrl]: rssOpenai, ...routes }, { articleBudget: { remaining: 2 } });
    const result = await rssAdapter.poll(sourceRow("rss", feedUrl), ctx);

    expect(result.items).toHaveLength(5);
    expect(requests.filter((request) => request.url.includes("/index/"))).toHaveLength(2);
    expect(result.items[0]!.text).toContain("Real paragraph of the article body");
    expect(result.items[0]!.text).not.toContain("Menu item");
    expect(result.items[0]!.summaryOnly).toBe(false);
    // Budget exhausted: the feed summary is kept and flagged.
    expect(result.items[4]!.summaryOnly).toBe(true);
  });

  it("skips archive entries older than 30 days", async () => {
    const { ctx } = fakeContext({ [FEED]: atomSimon }, { now: Date.UTC(2027, 0, 1) / 1000 });
    expect((await rssAdapter.poll(sourceRow("rss", FEED), ctx)).items).toEqual([]);
  });
});

describe("githubAdapter", () => {
  it("reads releases from the Atom feed without touching the REST API", async () => {
    const { ctx, requests } = fakeContext({ "https://github.com/vllm-project/vllm/releases.atom": releasesAtom });
    const result = await githubAdapter.poll(sourceRow("github", "vllm-project/vllm"), ctx);
    expect(result.items).toHaveLength(4);
    expect(result.items[0]).toMatchObject({
      platform: "github", kind: "release", title: "vllm-project/vllm v0.30.0rc2",
      url: "https://github.com/vllm-project/vllm/releases/tag/v0.30.0rc2", author: { handle: "vllm-project" },
    });
    expect(requests.every((request) => !request.url.includes("api.github.com"))).toBe(true);
  });

  it("sends the token only to api.github.com for the trending search", async () => {
    const url = "https://api.github.com/search/repositories?q=topic%3Allm+stars%3A%3E200+pushed%3A%3E2026-09-13&sort=stars&order=desc&per_page=10";
    const { ctx, requests } = fakeContext({ [url]: searchJson }, { githubToken: "test-token" });
    const result = await githubAdapter.poll(sourceRow("github", "search:topic:llm stars:>200"), ctx);
    expect(requests.map((request) => request.url)).toEqual([url]);
    expect(requests[0]!.headers.Authorization).toBe("Bearer test-token");
    expect(result.items[0]).toMatchObject({ externalId: "repo:1136590548", title: "affaan-m/ECC", author: { handle: "affaan-m" } });
    expect(result.metrics[0]).toMatchObject({ likes: 263473 });
  });
});

describe("extractArticleText", () => {
  it("falls back to all paragraphs when there is no article element", async () => {
    const text = await extractArticleText("<html><body><div><p>First.</p><p>Second.</p></div><script>evil()</script></body></html>");
    expect(text).toBe("First.\nSecond.");
  });
});
