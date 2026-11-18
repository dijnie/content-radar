import { describe, expect, it } from "vitest";
import { extractArticleText } from "../../src/sources/article-text";

describe("extractArticleText on real-world markup", () => {
  it("keeps table evidence between paragraphs and decodes visible HTML entities", async () => {
    const article = "<article><p>We&#x27;ve measured throughput:</p><table><tr><th>Model</th><th>Images/hour</th></tr><tr><td>Atlas</td><td>120</td></tr></table><p>Results &amp; caveats.</p></article>";
    expect((await extractArticleText(article)).split("\n")).toEqual(["We've measured throughput:", "Model", "Images/hour", "Atlas", "120", "Results & caveats."]);
  });

  it("keeps every block when end tags are omitted, which HTML allows for p and li", async () => {
    const html = "<html><body><article><p>First paragraph<p>Second paragraph<ul><li>alpha<li>beta</ul><p>After the list</article></body></html>";
    expect((await extractArticleText(html)).split("\n")).toEqual(["First paragraph", "Second paragraph", "alpha", "beta", "After the list"]);
  });

  it("does not lose the article when a chrome element is never closed", async () => {
    const html = `<html><body><nav><p>Menu</p><article>${"<p>Body paragraph with enough words to count as article text.</p>".repeat(10)}</article></body></html>`;
    const text = await extractArticleText(html);
    expect(text).toContain("Body paragraph");
  });

  it("keeps the last block even if the document ends inside it", async () => {
    expect(await extractArticleText("<p>One</p><p>Two without an end")).toBe("One\nTwo without an end");
  });

  it("separates a block nested in another block instead of gluing their text", async () => {
    expect((await extractArticleText("<blockquote><p>Quoted line</p><p>Second quoted line</p></blockquote><p>Reply</p>")).split("\n")).toEqual(["Quoted line", "Second quoted line", "Reply"]);
  });
});
