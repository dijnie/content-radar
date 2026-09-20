import { describe, expect, it } from "vitest";
import { cheapFilter, keywordPattern, type FilterConfig } from "../../src/ingest/cheap-filter";
import type { NormalizedItem } from "../../src/sources/source-adapter";

const CONFIG: FilterConfig = {
  languages: ["en", "vi"],
  minTextLength: 40,
  topics: [
    { slug: "ai", keywords: ["ai", "llm", "agent"] },
    { slug: "backend", keywords: ["postgres", "latency"] },
  ],
};
const KEYWORD_SOURCE = { always_pass: 0, topic_hint: null };
const LONG = "We benchmarked the new LLM against our production traffic and measured the results carefully.";

function item(overrides: Partial<NormalizedItem>): NormalizedItem {
  return {
    platform: "x", externalId: "1", url: "https://x.com/a/status/1", canonicalUrl: "https://x.com/a/status/1", links: [],
    author: { platform: "x", handle: "alice", displayName: null }, kind: "post", parentExternalId: null, title: null,
    text: LONG, lang: "en", publishedAt: 0, raw: null, ...overrides,
  };
}

describe("cheapFilter", () => {
  it.each([
    ["a repost", item({ kind: "repost" }), { pass: false, reason: "repost" }],
    ["a reply to someone else", item({ kind: "reply", replyToHandle: "bob" }), { pass: false, reason: "reply" }],
    ["a reply without a known target", item({ kind: "reply", replyToHandle: null }), { pass: false, reason: "reply" }],
    ["a self-reply thread", item({ kind: "reply", replyToHandle: "Alice" }), { pass: true, topicHint: "ai" }],
    ["a post that is only a link", item({ text: "LLM https://example.com/a-very-long-url-that-should-not-count-as-prose" }), { pass: false, reason: "too_short" }],
    ["an unsupported language", item({ lang: "ja" }), { pass: false, reason: "language" }],
    ["a regional language tag", item({ lang: "en-US" }), { pass: true, topicHint: "ai" }],
    ["an unknown language", item({ lang: null }), { pass: true, topicHint: "ai" }],
    ["off-topic prose", item({ text: "I had a wonderful breakfast this morning with fresh bread and coffee." }), { pass: false, reason: "no_topic_match" }],
    ["a quote", item({ kind: "quote" }), { pass: true, topicHint: "ai" }],
  ])("%s", (_name, input, expected) => {
    expect(cheapFilter(input, KEYWORD_SOURCE, CONFIG)).toEqual(expected);
  });

  it("matches whole words only", () => {
    const pattern = keywordPattern(["ai"])!;
    expect(pattern.test("We maintain the trail daily")).toBe(false);
    expect(pattern.test("New AI: faster")).toBe(true);
    expect(cheapFilter(item({ text: "We maintain the mountain trail every single day of the long summer." }), KEYWORD_SOURCE, CONFIG)).toEqual({ pass: false, reason: "no_topic_match" });
  });

  it("lets always_pass sources and comments skip the keyword step but not the earlier rules", () => {
    const offTopic = "I had a wonderful breakfast this morning with fresh bread and coffee.";
    const trusted = { always_pass: 1, topic_hint: "backend" };
    expect(cheapFilter(item({ text: offTopic }), trusted, CONFIG)).toEqual({ pass: true, topicHint: "backend" });
    expect(cheapFilter(item({ text: offTopic, kind: "comment" }), KEYWORD_SOURCE, CONFIG)).toEqual({ pass: true, topicHint: null });
    expect(cheapFilter(item({ text: "short" }), trusted, CONFIG)).toEqual({ pass: false, reason: "too_short" });
    expect(cheapFilter(item({ kind: "repost" }), trusted, CONFIG)).toEqual({ pass: false, reason: "repost" });
  });

  it("prefers the source's topic when several match", () => {
    const both = item({ text: "Our LLM serving stack cut Postgres query latency in half during the benchmark run." });
    expect(cheapFilter(both, { always_pass: 0, topic_hint: "backend" }, CONFIG)).toEqual({ pass: true, topicHint: "backend" });
    expect(cheapFilter(both, KEYWORD_SOURCE, CONFIG)).toEqual({ pass: true, topicHint: "ai" });
  });
});
