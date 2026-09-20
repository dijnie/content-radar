import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { DEFAULT_PARAMS, fallbackHeadline, median, medianAbsoluteDeviation, promoteSingletons, scoreStory, storyStatus, velocityZ, type StoryScoreInput } from "../../src/index";

const BASE: StoryScoreInput = {
  independentSources: 1, maxVelocityZ: null, claims: [{ hasNumbers: true, firstHand: false }, { hasNumbers: false, firstHand: false }],
  hasCounter: false, maxCosineToOtherStories: 0.4, hoursSinceLatestClaim: 6,
};

describe("robust z", () => {
  it("computes median and MAD", () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBe(0);
    expect(medianAbsoluteDeviation([1, 2, 3, 4, 100])).toBe(1);
  });

  it("is resistant to one viral outlier in the baseline", () => {
    const history = [100, 110, 90, 105, 95, 100, 98, 102, 101, 99, 250_000];
    const baseline = { median: median(history), mad: medianAbsoluteDeviation(history), sampleSize: history.length };
    expect(velocityZ(400, 48, baseline, DEFAULT_PARAMS)!).toBeGreaterThan(3);
    expect(Math.abs(velocityZ(101, 48, baseline, DEFAULT_PARAMS)!)).toBeLessThan(1);
  });

  it("projects a young post to a 24-hour figure, with a floor on the divisor", () => {
    const baseline = { median: 100, mad: 10, sampleSize: 30 };
    expect(velocityZ(50, 12, baseline, DEFAULT_PARAMS)).toBeCloseTo(0, 6);
    expect(velocityZ(50, 4, baseline, DEFAULT_PARAMS)).toBeCloseTo((50 / 0.25 - 100) / 14.826, 6);
    expect(velocityZ(100, 30, baseline, DEFAULT_PARAMS)).toBeCloseTo(0, 6);
  });

  it("refuses to judge a post that is too young or an author with too little history", () => {
    expect(velocityZ(500, 1, { median: 100, mad: 10, sampleSize: 30 }, DEFAULT_PARAMS)).toBeNull();
    expect(velocityZ(500, 12, { median: 100, mad: 10, sampleSize: 5 }, DEFAULT_PARAMS)).toBeNull();
    expect(velocityZ(500, 12, null, DEFAULT_PARAMS)).toBeNull();
  });

  it("stays finite for an author whose posts all perform alike", () => {
    expect(velocityZ(130, 48, { median: 100, mad: 0, sampleSize: 30 }, DEFAULT_PARAMS)).toBeCloseTo(3, 6);
  });
});

describe("scoreStory", () => {
  it("matches the formula by hand", () => {
    const { score, subscores } = scoreStory(BASE, DEFAULT_PARAMS);
    expect(subscores).toEqual({ sources: Math.log2(2) / Math.log2(6), velocity: 0.5, specificity: 0.5, counter: 0, novelty: 0.6, recency: Math.exp((-Math.LN2 * 6) / 48) });
    const expected = 0.3 * subscores.sources + 0.2 * 0.5 + 0.15 * 0.5 + 0.1 * 0 + 0.15 * 0.6 + 0.1 * subscores.recency;
    expect(score).toBeCloseTo(100 * expected, 1);
  });

  it("stays within 0..100 and never falls when an independent source is added", () => {
    fc.assert(
      fc.property(
        fc.record({
          independentSources: fc.integer({ min: 0, max: 40 }),
          maxVelocityZ: fc.option(fc.double({ min: -50, max: 50, noNaN: true }), { nil: null }),
          hasCounter: fc.boolean(),
          maxCosineToOtherStories: fc.double({ min: -1, max: 1, noNaN: true }),
          hoursSinceLatestClaim: fc.double({ min: 0, max: 10_000, noNaN: true }),
          claims: fc.array(fc.record({ hasNumbers: fc.boolean(), firstHand: fc.boolean() }), { maxLength: 8 }),
        }),
        (input) => {
          const { score } = scoreStory(input, DEFAULT_PARAMS);
          expect(score).toBeGreaterThanOrEqual(0);
          expect(score).toBeLessThanOrEqual(100);
          expect(scoreStory({ ...input, independentSources: input.independentSources + 1 }, DEFAULT_PARAMS).score).toBeGreaterThanOrEqual(score);
        },
      ),
    );
  });

  it("rewards a counterpoint, fresh news and novelty", () => {
    const base = scoreStory(BASE, DEFAULT_PARAMS).score;
    expect(scoreStory({ ...BASE, hasCounter: true }, DEFAULT_PARAMS).score).toBeCloseTo(base + 10, 1);
    expect(scoreStory({ ...BASE, hoursSinceLatestClaim: 48 }, DEFAULT_PARAMS).subscores.recency).toBeCloseTo(0.5, 6);
    expect(scoreStory({ ...BASE, maxCosineToOtherStories: 0.95 }, DEFAULT_PARAMS).score).toBeLessThan(base);
  });

  it("drops a story back to a lead when its second source goes away", () => {
    expect(storyStatus(2)).toBe("ready");
    expect(storyStatus(1)).toBe("lead");
    expect(storyStatus(0)).toBe("lead");
    expect(scoreStory({ ...BASE, independentSources: 1 }, DEFAULT_PARAMS).score).toBeLessThan(scoreStory({ ...BASE, independentSources: 2 }, DEFAULT_PARAMS).score);
  });
});

describe("fallbackHeadline", () => {
  const claim = (id: number, hasNumbers: boolean, firstHand: boolean, publishedAt: number) => ({ id, textVi: `Câu ${id}`, hasNumbers, firstHand, publishedAt });

  it("prefers the most specific claim, then the earliest", () => {
    expect(fallbackHeadline([claim(1, false, false, 10), claim(2, true, true, 30), claim(3, true, false, 5)])).toBe("Câu 2");
    expect(fallbackHeadline([claim(1, true, false, 20), claim(2, true, false, 10)])).toBe("Câu 2");
    expect(fallbackHeadline([])).toBeNull();
  });
});

describe("promoteSingletons", () => {
  it("keeps only lone claims whose engagement is anomalous for their author", () => {
    const z = new Map<number, number | null>([[1, 3.5], [2, 2.9], [3, null], [4, 3]]);
    expect(promoteSingletons([4, 3, 2, 1, 5], z, DEFAULT_PARAMS)).toEqual([[1], [4]]);
  });
});
