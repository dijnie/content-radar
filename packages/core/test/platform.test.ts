import { describe, expect, it } from "vitest";
import { normalizeHandle } from "../src/index";

describe("normalizeHandle", () => {
  it("lowercases platforms with case-insensitive handles and strips the @", () => {
    expect(normalizeHandle("x", " @Karpathy ")).toBe("karpathy");
    expect(normalizeHandle("github", "Anvaka")).toBe("anvaka");
  });

  it("keeps case where the platform is case-sensitive", () => {
    expect(normalizeHandle("hn", "PG")).toBe("PG");
    expect(normalizeHandle("rss", "simonwillison.net")).toBe("simonwillison.net");
  });
});
