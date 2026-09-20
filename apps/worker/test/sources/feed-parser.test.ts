import { describe, expect, it } from "vitest";
import atomSimon from "../fixtures/rss/atom-simonwillison.xml?raw";
import rssOpenai from "../fixtures/rss/rss-openai.xml?raw";
import { decodeEntities, hrefsIn, htmlToText, parseFeed } from "../../src/sources/feed-parser";

describe("parseFeed", () => {
  it("reads a real Atom feed", () => {
    const feed = parseFeed(atomSimon, 30);
    expect(feed.title).toBe("Simon Willison's Weblog");
    expect(feed.entries).toHaveLength(4);
    const first = feed.entries[0]!;
    expect(first).toMatchObject({
      guid: "https://simonwillison.net/2026/Sep/19/datasette-auth-github/",
      link: "https://simonwillison.net/2026/Sep/19/datasette-auth-github/",
      title: "datasette-auth-github 1.0",
      publishedAt: Date.UTC(2026, 8, 19, 19, 52, 2) / 1000,
    });
    expect(htmlToText(first.html)).toContain("I run this GitHub login plugin");
    expect(hrefsIn(first.html)).toContain("https://github.com/simonw/datasette-auth-github/releases/tag/1.0");
  });

  it("reads a real RSS feed with CDATA", () => {
    const feed = parseFeed(rssOpenai, 30);
    expect(feed.entries).toHaveLength(5);
    expect(feed.entries[0]).toMatchObject({
      title: "Introducing the Australian Youth Safety Blueprint",
      link: "https://openai.com/index/australian-youth-safety-blueprint",
      guid: "https://openai.com/index/australian-youth-safety-blueprint",
      publishedAt: Date.UTC(2026, 8, 18, 12, 0, 0) / 1000,
    });
  });

  it("caps the number of entries so a 1,000-item feed stays cheap", () => {
    expect(parseFeed(rssOpenai, 2).entries).toHaveLength(2);
  });

  it("skips entries without a link and tolerates junk", () => {
    const xml = `<rss><channel><title>T</title><item><title>no link</title></item><item><link>https://a.example/1</link></item></channel></rss>`;
    expect(parseFeed(xml, 10).entries.map((entry) => entry.guid)).toEqual(["https://a.example/1"]);
    expect(parseFeed("<html>not a feed</html>", 10).entries).toEqual([]);
  });
});

describe("text helpers", () => {
  it("decodes named and numeric entities and drops invalid code points", () => {
    expect(decodeEntities("a &amp; b &#8217; &#x1F600; &bogus; &#0;")).toBe("a & b ’ \u{1F600} &bogus; ");
  });

  it("drops script and style content", () => {
    expect(htmlToText("<p>Hello</p><script>alert(1)</script><style>p{}</style><p>World</p>").replace(/\s+/g, " ").trim()).toBe("Hello World");
  });
});
