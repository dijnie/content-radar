import { describe, expect, it } from "vitest";
import { DEFAULT_PARAMS, leidenClusterer, partitionKey, resolutionSweep, splitDisconnected, type Clustering, type WeightedEdge } from "../../src/index";
import football from "../fixtures/football.json";
import karate from "../fixtures/karate-club.json";
import { modularity, mulberry32, sparseSocial, syntheticStories } from "../fixtures/generate";

const unweighted = (edges: number[][]): WeightedEdge[] => edges.map(([a, b]) => ({ claimA: a! + 1, claimB: b! + 1, weight: 1 }));
const nodesOf = (count: number) => Array.from({ length: count }, (_, index) => index + 1);
const MODULARITY = { seed: 42, resolution: 1, quality: "modularity", minCommunitySize: 1 } as const;
const CPM = { seed: DEFAULT_PARAMS.seed, quality: "cpm", minCommunitySize: DEFAULT_PARAMS.minCommunitySize } as const;

function communityOf(clustering: Clustering): Map<number, number> {
  const map = new Map<number, number>();
  clustering.communities.forEach((members, index) => members.forEach((member) => map.set(member, index)));
  clustering.singletons.forEach((member, index) => map.set(member, clustering.communities.length + index));
  return map;
}

describe("leidenClusterer against reference networks", () => {
  const REFERENCES = { "karate club": { fixture: karate, best: 0.4198 }, "college football": { fixture: football, best: 0.6046 } };

  it.each(Object.keys(REFERENCES) as (keyof typeof REFERENCES)[])("%s: modularity within 5%% of the best known value", (name) => {
    const { fixture, best } = REFERENCES[name];
    const edges = unweighted(fixture.edges);
    const clustering = leidenClusterer.cluster(nodesOf(fixture.nodeCount), edges, MODULARITY);
    const q = modularity(edges, communityOf(clustering));
    expect(q).toBeGreaterThanOrEqual(best * 0.95);
    expect(q).toBeLessThanOrEqual(best + 1e-6);
  });

  it("recovers most football conferences", () => {
    const clustering = leidenClusterer.cluster(nodesOf(football.nodeCount), unweighted(football.edges), MODULARITY);
    const assigned = communityOf(clustering);
    let agree = 0;
    let pairs = 0;
    for (let a = 0; a < football.nodeCount; a++) {
      for (let b = a + 1; b < football.nodeCount; b++) {
        if (football.conferences[a] !== football.conferences[b]) continue;
        pairs++;
        if (assigned.get(a + 1) === assigned.get(b + 1)) agree++;
      }
    }
    expect(agree / pairs).toBeGreaterThan(0.8);
  });
});

describe("determinism", () => {
  const { nodes, edges } = syntheticStories();

  it("gives one partition across twenty runs with the same seed", () => {
    const keys = new Set(Array.from({ length: 20 }, () => partitionKey(leidenClusterer.cluster(nodes, edges, { ...CPM, resolution: DEFAULT_PARAMS.resolution }))));
    expect(keys.size).toBe(1);
  });

  it("does not depend on the order of nodes or edges, nor on edge direction", () => {
    const random = mulberry32(5);
    const shuffle = <T>(values: readonly T[]): T[] => [...values].map((value) => ({ value, key: random() })).sort((a, b) => a.key - b.key).map((entry) => entry.value);
    const base = partitionKey(leidenClusterer.cluster(nodes, edges, { ...CPM, resolution: DEFAULT_PARAMS.resolution }));
    const flipped = shuffle(edges).map((edge, index) => (index % 2 ? edge : { claimA: edge.claimB, claimB: edge.claimA, weight: edge.weight }));
    expect(partitionKey(leidenClusterer.cluster(shuffle(nodes), flipped, { ...CPM, resolution: DEFAULT_PARAMS.resolution }))).toBe(base);
  });

  it("canonicalises output: members ascending, communities ordered by smallest member", () => {
    const { communities, singletons } = leidenClusterer.cluster(nodes, edges, { ...CPM, resolution: DEFAULT_PARAMS.resolution });
    for (const members of communities) expect(members).toEqual([...members].sort((a, b) => a - b));
    expect(communities.map((members) => members[0])).toEqual([...communities.map((members) => members[0]!)].sort((a, b) => a - b));
    expect(singletons).toEqual([...singletons].sort((a, b) => a - b));
  });

  it("handles an empty graph and ignores edges to unknown nodes", () => {
    expect(leidenClusterer.cluster([], [], { ...CPM, resolution: 0.5 })).toEqual({ communities: [], singletons: [], quality: 0 });
    const result = leidenClusterer.cluster([1, 2], [{ claimA: 1, claimB: 99, weight: 1 }, { claimA: 1, claimB: 1, weight: 1 }], { ...CPM, resolution: 0.5 });
    expect(result).toMatchObject({ communities: [], singletons: [1, 2] });
  });
});

describe("the default resolution on weighted fixtures", () => {
  it("keeps five stories that share a popular entity apart", () => {
    const { nodes, edges, truth } = syntheticStories();
    const { communities } = leidenClusterer.cluster(nodes, edges, { ...CPM, resolution: DEFAULT_PARAMS.resolution });
    expect(communities).toHaveLength(5);
    for (const members of communities) expect(new Set(members.map((member) => truth.get(member))).size).toBe(1);
  });

  it("does not collapse sparse social data into one giant cluster, and leaves isolated claims as singletons", () => {
    const { nodes, edges, truth } = sparseSocial();
    const { communities, singletons } = leidenClusterer.cluster(nodes, edges, { ...CPM, resolution: DEFAULT_PARAMS.resolution });
    const isolated = nodes.filter((node) => truth.get(node) === -1);
    expect(isolated.length / nodes.length).toBeGreaterThan(0.65);
    expect(singletons.filter((node) => truth.get(node) === -1).length).toBeGreaterThanOrEqual(isolated.length * 0.95);
    // No community mixes different planted stories, and nothing swallows the graph.
    for (const members of communities) expect(new Set(members.map((member) => truth.get(member)).filter((story) => story !== -1)).size).toBeLessThanOrEqual(1);
    expect(Math.max(...communities.map((members) => members.length))).toBeLessThanOrEqual(300);
    expect(communities.length).toBeGreaterThanOrEqual(12);
  });

  it("every community it returns is connected", () => {
    for (const fixture of [syntheticStories(), sparseSocial()]) {
      const { communities } = leidenClusterer.cluster(fixture.nodes, fixture.edges, { ...CPM, resolution: DEFAULT_PARAMS.resolution });
      for (const members of communities) {
        const inside = new Set(members);
        const reached = new Set([members[0]!]);
        for (let grew = true; grew; ) {
          grew = false;
          for (const { claimA, claimB } of fixture.edges) {
            if (!inside.has(claimA) || !inside.has(claimB) || reached.has(claimA) === reached.has(claimB)) continue;
            reached.add(claimA).add(claimB);
            grew = true;
          }
        }
        expect(reached.size).toBe(members.length);
      }
    }
  });
});

describe("splitDisconnected", () => {
  it("separates the parts of a label that no edge joins, whatever the edge order", () => {
    const assignment = new Map([[1, 0], [2, 0], [3, 0], [4, 0], [5, 9]]);
    const edges: WeightedEdge[] = [{ claimA: 3, claimB: 4, weight: 1 }, { claimA: 1, claimB: 2, weight: 1 }, { claimA: 2, claimB: 5, weight: 1 }];
    const expected = new Map([[1, 1], [2, 1], [3, 3], [4, 3], [5, 5]]);
    expect(splitDisconnected(assignment, edges)).toEqual(expected);
    expect(splitDisconnected(assignment, [...edges].reverse())).toEqual(expected);
  });
});

describe("resolutionSweep", () => {
  it("finds the plateau between the two weight levels of a planted complete graph", () => {
    // Complete graph over 5 groups of 8: weight 0.9 inside a group, 0.05 across. Topology says nothing; only weights do.
    const nodes = nodesOf(40);
    const edges: WeightedEdge[] = [];
    for (let a = 1; a <= 40; a++) for (let b = a + 1; b <= 40; b++) edges.push({ claimA: a, claimB: b, weight: Math.floor((a - 1) / 8) === Math.floor((b - 1) / 8) ? 0.9 : 0.05 });
    const sweep = resolutionSweep(leidenClusterer, nodes, edges, [0.01, 0.02, 0.1, 0.2, 0.3, 0.4, 0.5, 1.2, 1.5], CPM);

    expect(sweep.points.map((point) => point.resolution)).toEqual([0.01, 0.02, 0.1, 0.2, 0.3, 0.4, 0.5, 1.2, 1.5]);
    expect(sweep.points[0]).toMatchObject({ communities: 1, largestCommunity: 40 });
    expect(sweep.points.at(-1)).toMatchObject({ communities: 0, singletons: 40 });
    expect(sweep.stableRange).toEqual({ from: 0.1, to: 0.5, communities: 5 });
    expect(sweep.recommended).toBe(0.3);
    expect(DEFAULT_PARAMS.resolution).toBeGreaterThanOrEqual(sweep.stableRange!.from);
    expect(DEFAULT_PARAMS.resolution).toBeLessThanOrEqual(sweep.stableRange!.to);
  });

  it("reports no stable range when nothing ever clusters", () => {
    expect(resolutionSweep(leidenClusterer, [1, 2, 3], [], [0.1, 0.5], CPM)).toMatchObject({ stableRange: null, recommended: null });
  });
});
