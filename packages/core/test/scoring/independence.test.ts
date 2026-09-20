import { describe, expect, it } from "vitest";
import { countIndependentSources, deriveRelations, type RelationClaim, type RelationItem } from "../../src/index";

const item = (id: number, overrides: Partial<RelationItem> = {}): RelationItem => ({ id, platform: "x", externalId: `t${id}`, kind: "post", parentExternalId: null, primaryLink: null, ...overrides });
const claim = (id: number, itemId: number, overrides: Partial<RelationClaim> = {}): RelationClaim => ({ id, itemId, kind: "report", firstHand: false, publishedAt: id * 100, ...overrides });

/** Runs derivation, then counts sources with the given claim -> author mapping. */
function sources(claims: RelationClaim[], items: RelationItem[], authorOf: Record<number, number | null>): number {
  const derived = new Map(deriveRelations(claims, items).map((relation) => [relation.claimId, relation.derivedFromClaimId]));
  return countIndependentSources(claims.map((c) => ({ id: c.id, authorId: authorOf[c.id] ?? null, derivedFromClaimId: derived.get(c.id) ?? null })));
}

describe("independent sources", () => {
  it("counts one author on two platforms once", () => {
    const items = [item(1), item(2, { platform: "rss", externalId: "blog-1", kind: "article" })];
    expect(sources([claim(1, 1), claim(2, 2)], items, { 1: 50, 2: 50 })).toBe(1);
  });

  it("counts a chain of quotes without measurements of their own once", () => {
    const items = [item(1), item(2, { kind: "quote", parentExternalId: "t1" }), item(3, { kind: "quote", parentExternalId: "t2" })];
    const claims = [claim(1, 1, { kind: "announcement" }), claim(2, 2), claim(3, 3)];
    expect(deriveRelations(claims, items).map((relation) => [relation.claimId, relation.derivedFromClaimId, relation.reason])).toEqual([
      [1, null, "original"], [2, 1, "quote_or_repost"], [3, 2, "quote_or_repost"],
    ]);
    expect(sources(claims, items, { 1: 50, 2: 51, 3: 52 })).toBe(1);
  });

  it("counts a quote that adds a first-hand measurement as a new source", () => {
    const items = [item(1), item(2, { kind: "quote", parentExternalId: "t1" })];
    const claims = [claim(1, 1, { kind: "announcement" }), claim(2, 2, { kind: "measurement", firstHand: true })];
    expect(sources(claims, items, { 1: 50, 2: 51 })).toBe(2);
  });

  it("counts six posts relaying one announcement once, through the shared origin URL", () => {
    const origin = "https://openai.com/index/new-model";
    const items = range(6).map((n) => item(n, { primaryLink: origin }));
    const claims = range(6).map((n) => claim(n, n, { kind: n === 1 ? "announcement" : "report" }));
    const authors = Object.fromEntries(range(6).map((n) => [n, 50 + n]));
    expect(sources(claims, items, authors)).toBe(1);
    expect(deriveRelations(claims, items).filter((relation) => relation.reason === "same_origin_url")).toHaveLength(5);
  });

  it("does not treat two essays that merely cite the same page as one origin", () => {
    // Neither item is *about* the shared URL, so neither has it as its primary link.
    const items = [item(1, { kind: "article" }), item(2, { kind: "article" })];
    expect(sources([claim(1, 1), claim(2, 2)], items, { 1: 50, 2: 51 })).toBe(2);
  });

  it("counts an opinion about a shared URL as its own voice", () => {
    const origin = "https://example.com/paper";
    const items = [item(1, { primaryLink: origin }), item(2, { primaryLink: origin })];
    expect(sources([claim(1, 1, { kind: "announcement" }), claim(2, 2, { kind: "opinion" })], items, { 1: 50, 2: 51 })).toBe(2);
  });

  it("counts a Hacker News rebuttal as a separate source, never as derived from its story", () => {
    const items = [item(1, { platform: "hn", externalId: "900", kind: "story", primaryLink: "https://example.com/post" }), item(2, { platform: "hn", externalId: "901", kind: "comment", parentExternalId: "900" })];
    const claims = [claim(1, 1), claim(2, 2, { kind: "opinion" })];
    expect(deriveRelations(claims, items)[1]).toMatchObject({ derivedFromClaimId: null, reason: "original" });
    expect(sources(claims, items, { 1: 50, 2: 51 })).toBe(2);
  });

  it("survives unknown authors, a parent outside the set and a derivation cycle", () => {
    expect(countIndependentSources([{ id: 1, authorId: null, derivedFromClaimId: null }, { id: 2, authorId: null, derivedFromClaimId: null }])).toBe(2);
    expect(countIndependentSources([{ id: 1, authorId: 5, derivedFromClaimId: 999 }])).toBe(1);
    expect(countIndependentSources([{ id: 1, authorId: 5, derivedFromClaimId: 2 }, { id: 2, authorId: 6, derivedFromClaimId: 1 }])).toBeGreaterThanOrEqual(1);
    expect(countIndependentSources([])).toBe(0);
  });
});

function range(count: number): number[] {
  return Array.from({ length: count }, (_, index) => index + 1);
}
