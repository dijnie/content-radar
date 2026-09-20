import { DEFAULT_PARAMS, leidenClusterer, matchCommunities, normalizeEntity, resolveParams, scoreStory } from "@radar/core";
import { describe, expect, it } from "vitest";

describe("@radar/core inside workerd", () => {
  it("runs the pure core without any Node API", () => {
    expect(navigator.userAgent).toBe("Cloudflare-Workers");
    expect(resolveParams({ windowDays: 10 }).windowDays).toBe(10);
    expect(normalizeEntity("DeepSeek-V4.1 Flash")).toBe("deepseek-v4.1 flash");

    const edges = [{ claimA: 1, claimB: 2, weight: 0.9 }, { claimA: 2, claimB: 3, weight: 0.9 }, { claimA: 1, claimB: 3, weight: 0.9 }, { claimA: 4, claimB: 5, weight: 0.9 }];
    const clustering = leidenClusterer.cluster([1, 2, 3, 4, 5, 6], edges, DEFAULT_PARAMS);
    expect(clustering.communities).toEqual([[1, 2, 3], [4, 5]]);
    expect(clustering.singletons).toEqual([6]);

    const lineage = matchCommunities([{ index: 0, members: [1, 2, 3], signature: [] }], [{ storyId: 9, members: [1, 2, 3], lastSeenAt: 0 }], [], new Set([1, 2, 3]), 3600, DEFAULT_PARAMS);
    expect(lineage.assignments[0]).toMatchObject({ storyId: 9, event: "continue" });
    expect(scoreStory({ independentSources: 2, maxVelocityZ: 3, claims: [], hasCounter: true, maxCosineToOtherStories: 0, hoursSinceLatestClaim: 0 }, DEFAULT_PARAMS).score).toBeGreaterThan(60);
  });
});
