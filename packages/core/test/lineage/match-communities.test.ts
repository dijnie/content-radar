import { describe, expect, it } from "vitest";
import { DEFAULT_PARAMS, entitySignature, jaccard, matchCommunities, type CurrentCommunity, type PreviousCommunity } from "../../src/index";

const HOUR = 3600;
const NOW = 1_790_000_000;
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
const cur = (index: number, members: number[], signature: number[] = []): CurrentCommunity => ({ index, members, signature });
const prev = (storyId: number, members: number[], hoursAgo = 1): PreviousCommunity => ({ storyId, members, lastSeenAt: NOW - hoursAgo * HOUR });
const everything = new Set(range(1, 10_000));
const match = (current: CurrentCommunity[], previous: PreviousCommunity[], dead: Parameters<typeof matchCommunities>[2] = [], window = everything) =>
  matchCommunities(current, previous, dead, window, NOW, DEFAULT_PARAMS);

describe("matchCommunities: the six events", () => {
  it("birth: a community with no relative gets a new story", () => {
    expect(match([cur(0, [1, 2, 3])], []).assignments).toEqual([{ index: 0, storyId: null, event: "birth", relatedStoryIds: [], jaccard: null }]);
  });

  it("continue: a mutual best match above the threshold keeps its story", () => {
    const result = match([cur(0, [1, 2, 3, 4, 9])], [prev(7, [1, 2, 3, 4])]);
    expect(result.assignments).toEqual([{ index: 0, storyId: 7, event: "continue", relatedStoryIds: [], jaccard: 0.8 }]);
    expect(result.deaths).toEqual([]);
  });

  it("split: the largest child keeps the story, the others are born from it", () => {
    const result = match([cur(0, range(1, 4)), cur(1, range(5, 10))], [prev(7, range(1, 10))]);
    expect(result.assignments).toEqual([
      { index: 0, storyId: null, event: "split", relatedStoryIds: [7], jaccard: 0.4 },
      { index: 1, storyId: 7, event: "split", relatedStoryIds: [7], jaccard: 0.6 },
    ]);
  });

  it("merge: the community inherits the largest parent and the others are absorbed", () => {
    const result = match([cur(0, range(1, 10))], [prev(3, range(1, 4)), prev(5, range(5, 10))]);
    expect(result.assignments).toEqual([{ index: 0, storyId: 5, event: "merge", relatedStoryIds: [3], jaccard: 0.6 }]);
    expect(result.mergedAway).toEqual([{ storyId: 3, intoIndex: 0, jaccard: 0.4 }]);
    expect(result.deaths).toEqual([]);
  });

  it("death: only after the lookback has passed without a successor", () => {
    expect(match([], [prev(7, [1, 2], 2)]).deaths).toEqual([]);
    expect(match([], [prev(7, [1, 2], 30)]).deaths).toEqual([7]);
  });

  it("revive: a dead story with a matching entity signature gets its id back", () => {
    const dead = [{ storyId: 42, signature: [10, 11, 12, 13], diedAt: NOW - 9 * 86_400 }, { storyId: 43, signature: [90, 91], diedAt: NOW - 86_400 }];
    const result = match([cur(0, [500, 501], [10, 11, 12, 99])], [], dead);
    expect(result.assignments).toEqual([{ index: 0, storyId: 42, event: "revive", relatedStoryIds: [], jaccard: 0.6 }]);
  });
});

describe("matchCommunities: the hard cases", () => {
  it("a story absent for a few hours keeps its id when it returns", () => {
    // Seen five hours ago, missing from the runs since, back now.
    const result = match([cur(0, [1, 2, 3, 4])], [prev(7, [1, 2, 3, 4], 5)]);
    expect(result.assignments[0]).toMatchObject({ storyId: 7, event: "continue" });
  });

  it("a living story survives its first 100 claims leaving the window together", () => {
    const earlier = prev(7, range(1, 160));
    const now = cur(0, range(101, 175));
    const window = new Set(range(101, 10_000));
    expect(jaccard(earlier.members, now.members)).toBeLessThan(DEFAULT_PARAMS.jaccardContinue);
    const result = match([now], [earlier], [], window);
    expect(result.assignments[0]).toMatchObject({ storyId: 7, event: "continue", jaccard: 0.8 });
    expect(result.deaths).toEqual([]);
  });

  it("does not revive beyond the horizon, nor on a weak signature match", () => {
    const tooOld = [{ storyId: 42, signature: [10, 11], diedAt: NOW - 31 * 86_400 }];
    expect(match([cur(0, [500, 501], [10, 11])], [], tooOld).assignments[0]).toMatchObject({ storyId: null, event: "birth" });
    const weak = [{ storyId: 42, signature: [10, 11, 12, 13], diedAt: NOW - 86_400 }];
    expect(match([cur(0, [500, 501], [10, 98, 99])], [], weak).assignments[0]).toMatchObject({ event: "birth" });
  });

  it("never hands one story id to two communities", () => {
    const dead = [{ storyId: 42, signature: [10, 11], diedAt: NOW - 86_400 }];
    const result = match([cur(0, [500], [10, 11]), cur(1, [600], [10, 11])], [], dead);
    expect(result.assignments.map((assignment) => assignment.storyId)).toEqual([42, null]);
  });

  it("treats a weak one-to-one overlap as a birth that remembers where it came from", () => {
    const result = match([cur(0, [1, 2, 3, 20, 21, 22, 23])], [prev(7, [1, 2, 3, 4, 5], 1)]);
    expect(result.assignments[0]).toMatchObject({ storyId: null, event: "birth", relatedStoryIds: [7] });
  });

  it("is independent of input order", () => {
    const current = [cur(0, range(1, 4)), cur(1, range(5, 10)), cur(2, [50, 51])];
    const previous = [prev(7, range(1, 10)), prev(9, [50, 51])];
    expect(match([...current].reverse(), [...previous].reverse())).toEqual(match(current, previous));
  });
});

describe("entitySignature", () => {
  it("ranks entities by total IDF, skips excluded ones, and returns a sorted set", () => {
    const entities = new Map([[1, [10, 20, 30]], [2, [10, 20]], [3, [10, 99]]]);
    const idf = new Map([[10, 0.1], [20, 0.9], [30, 0.8], [99, 0.7]]);
    expect(entitySignature([1, 2, 3], entities, idf, new Set([99]))).toEqual([10, 20, 30]);
    expect(entitySignature([], entities, idf)).toEqual([]);
  });
});
