import { describe, expect, it } from "vitest";
import { canonicalizeUrl, canonicalLinks } from "../../src/sources/canonical-url";

describe("canonicalizeUrl", () => {
  it.each([
    ["http://WWW.Example.com/Post/?utm_source=x&b=2&a=1#frag", "https://example.com/Post?a=1&b=2"],
    ["https://twitter.com/simonw/status/1?s=20&t=abc", "https://x.com/simonw/status/1"],
    ["https://mobile.twitter.com/simonw/status/1", "https://x.com/simonw/status/1"],
    ["https://example.com/", "https://example.com"],
    ["https://example.com/?q=1", "https://example.com/?q=1"],
    ["https://example.com/a/b///", "https://example.com/a/b"],
  ])("%s -> %s", (input, expected) => {
    expect(canonicalizeUrl(input)).toBe(expected);
  });

  it("maps differently decorated links to one canonical form", () => {
    const a = canonicalizeUrl("https://openai.com/index/gpt?utm_campaign=launch");
    const b = canonicalizeUrl("http://www.openai.com/index/gpt/#top");
    expect(a).toBe(b);
  });

  it("returns null for non-HTTP input", () => {
    expect(canonicalizeUrl("mailto:a@example.com")).toBeNull();
    expect(canonicalizeUrl("not a url")).toBeNull();
  });

  it("dedupes links and drops the item's own URL", () => {
    const links = canonicalLinks(["https://a.example/x?utm_source=1", "https://a.example/x", "https://self.example/p", "javascript:0"], "https://self.example/p");
    expect(links).toEqual(["https://a.example/x"]);
  });
});
