import { Graph, leiden } from "leiden-ts";
import createGraph from "ngraph.graph";
import { detectClusters, type DetectClustersOptions } from "ngraph.leiden";
import { describe, expect, it } from "vitest";
import {
  canonicalPartition,
  KARATE_CLUB_EDGES,
  PLANTED_NODES,
  plantedCompleteGraph,
  plantedPartition,
  type WeightedEdge,
} from "./graph-fixtures";

const KARATE_NODES = 34;
const SEED = 42;

function ngraphPartition(
  nodeCount: number,
  edges: readonly (readonly number[])[],
  options: DetectClustersOptions,
): { partition: string; communities: number } {
  const graph = createGraph();
  for (let node = 0; node < nodeCount; node++) graph.addNode(node);
  for (const [source, target, weight] of edges) graph.addLink(source!, target!, { weight: weight ?? 1 });
  const clusters = detectClusters(graph, options);
  const assignment = Array.from({ length: nodeCount }, (_, node) => clusters.getClass(node));
  return { partition: canonicalPartition(assignment), communities: new Set(assignment).size };
}

function leidenTsPartition(
  nodeCount: number,
  edges: readonly (readonly number[])[],
  options: { seed: number; resolution?: number },
): { partition: string; communities: number; modularity: number } {
  const graph = Graph.fromEdgeList(nodeCount, edges as never);
  const result = leiden(graph, options);
  return {
    partition: canonicalPartition(result.partition.assignments),
    communities: result.partition.numCommunities,
    modularity: result.modularity,
  };
}

describe("runtime", () => {
  it("runs inside workerd, not Node", () => {
    expect(navigator.userAgent).toBe("Cloudflare-Workers");
  });

  it("has the full karate club fixture", () => {
    expect(KARATE_CLUB_EDGES).toHaveLength(78);
  });
});

describe("ngraph.leiden", () => {
  it("finds the known karate club structure with modularity", () => {
    const result = ngraphPartition(KARATE_NODES, KARATE_CLUB_EDGES, { randomSeed: SEED });
    console.log("ngraph.leiden karate modularity communities:", result.communities);
    expect(result.communities).toBeGreaterThanOrEqual(3);
    expect(result.communities).toBeLessThanOrEqual(5);
  });

  it("is deterministic for a fixed seed", () => {
    const weighted = plantedCompleteGraph(7);
    const variants: DetectClustersOptions[] = [{ randomSeed: SEED }, { randomSeed: SEED, quality: "cpm", resolution: 0.3 }];
    for (const options of variants) {
      const first = ngraphPartition(PLANTED_NODES, weighted, options);
      const second = ngraphPartition(PLANTED_NODES, weighted, options);
      expect(second.partition).toBe(first.partition);
    }
    const karateA = ngraphPartition(KARATE_NODES, KARATE_CLUB_EDGES, { randomSeed: SEED });
    const karateB = ngraphPartition(KARATE_NODES, KARATE_CLUB_EDGES, { randomSeed: SEED });
    expect(karateB.partition).toBe(karateA.partition);
  });

  it("honours edge weights under CPM across a gamma sweep", () => {
    const weighted = plantedCompleteGraph(7);
    const sweep = [0.02, 0.3, 1.5].map((resolution) => ({
      resolution,
      ...ngraphPartition(PLANTED_NODES, weighted, { randomSeed: SEED, quality: "cpm", resolution }),
    }));
    console.log("ngraph.leiden CPM sweep:", JSON.stringify(sweep.map(({ resolution, communities }) => ({ resolution, communities }))));

    // Below the inter-cluster weight everything merges; between the two weight
    // levels exactly the planted clusters survive; above the intra-cluster
    // weight nothing holds together.
    expect(sweep[0]!.communities).toBe(1);
    expect(sweep[1]!.partition).toBe(plantedPartition());
    expect(sweep[2]!.communities).toBe(PLANTED_NODES);
  });

  it("ignoring weights loses the planted clusters, proving the weights matter", () => {
    const unweighted = plantedCompleteGraph(7).map(([s, t]): WeightedEdge => [s, t, 1]);
    const result = ngraphPartition(PLANTED_NODES, unweighted, { randomSeed: SEED, quality: "cpm", resolution: 0.3 });
    expect(result.partition).not.toBe(plantedPartition());
  });
});

describe("leiden-ts", () => {
  it("finds the known karate club structure", () => {
    const result = leidenTsPartition(KARATE_NODES, KARATE_CLUB_EDGES, { seed: SEED });
    console.log("leiden-ts karate:", result.communities, "communities, Q =", result.modularity.toFixed(4));
    expect(result.communities).toBeGreaterThanOrEqual(3);
    expect(result.communities).toBeLessThanOrEqual(5);
    expect(result.modularity).toBeGreaterThan(0.38);
  });

  it("is deterministic for a fixed seed", () => {
    const weighted = plantedCompleteGraph(7);
    const first = leidenTsPartition(PLANTED_NODES, weighted, { seed: SEED });
    const second = leidenTsPartition(PLANTED_NODES, weighted, { seed: SEED });
    expect(second.partition).toBe(first.partition);
  });

  it("honours edge weights under modularity", () => {
    const result = leidenTsPartition(PLANTED_NODES, plantedCompleteGraph(7), { seed: SEED });
    console.log("leiden-ts weighted planted communities:", result.communities);
    expect(result.partition).toBe(plantedPartition());
  });
});
