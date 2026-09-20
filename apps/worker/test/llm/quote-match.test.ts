import { describe, expect, it } from "vitest";
import { normalizeForMatch, quoteFoundIn } from "../../src/llm/extract/quote-match";

const SOURCE = "We ran the eval on 1,200 prompts. Latency dropped 40% on our internal benchmark after the rewrite, and cost fell too.";

describe("quoteFoundIn", () => {
  it("accepts a verbatim excerpt regardless of case and spacing", () => {
    expect(quoteFoundIn("latency dropped 40%   on our internal benchmark", SOURCE)).toBe(true);
  });

  it("treats Vietnamese NFC and NFD as the same text", () => {
    const nfc = "Độ trễ giảm 40% trên bộ thử nội bộ".normalize("NFC");
    const nfd = `Nhóm cho biết: ${"Độ trễ giảm 40% trên bộ thử nội bộ".normalize("NFD")} sau khi viết lại.`;
    expect(nfc).not.toBe(nfd.slice(15, 15 + nfc.length));
    expect(quoteFoundIn(nfc, nfd)).toBe(true);
  });

  it("folds curly quotes, dashes, ellipses and non-breaking spaces", () => {
    const source = "She said “it’s 3× faster” — on the same hardware… mostly.";
    expect(quoteFoundIn(`"it's 3× faster" - on the same hardware...`, source)).toBe(true);
  });

  it("folds full-width CJK punctuation and ignores zero-width characters", () => {
    const source = "模型的延迟降低了40%，成本也下降了！";
    expect(quoteFoundIn("延迟降低了40%,成本也下降了!", source)).toBe(true);
    expect(quoteFoundIn("latency​ dropped 40%", SOURCE)).toBe(true);
  });

  it("forgives one dropped word through the fuzzy path", () => {
    expect(quoteFoundIn("Latency dropped 40% on our benchmark after the rewrite, and cost fell too.", SOURCE)).toBe(true);
  });

  it("rejects a paraphrase, a fabricated number and a stitched quote", () => {
    expect(quoteFoundIn("Response times improved by almost half in their tests", SOURCE)).toBe(false);
    expect(quoteFoundIn("Latency dropped 90% on our internal benchmark after the rewrite", SOURCE)).toBe(false);
    expect(quoteFoundIn("We ran the eval and cost fell too", SOURCE)).toBe(false);
    expect(quoteFoundIn("", SOURCE)).toBe(false);
  });

  it("never forgives a changed number, however long the rest of the quote is", () => {
    // 13 of 14 tokens match in order (93%), so only the number rule can reject this.
    expect(quoteFoundIn("Latency dropped 90% on our internal benchmark after the rewrite, and cost fell too.", SOURCE)).toBe(false);
    expect(quoteFoundIn("We ran the eval on 9,900 prompts. Latency dropped 40% on our internal benchmark", SOURCE)).toBe(false);
  });

  it("does not let a short quote through the fuzzy path", () => {
    expect(quoteFoundIn("latency rose 40%", SOURCE)).toBe(false);
  });
});

describe("normalizeForMatch", () => {
  it("removes control characters", () => {
    expect(normalizeForMatch("a\u0000b‮c")).toBe("a b c");
  });
});
