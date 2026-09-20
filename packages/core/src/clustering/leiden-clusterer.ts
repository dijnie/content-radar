import createGraph from "ngraph.graph";
import { detectClusters } from "ngraph.leiden";
import { canonicalClustering, mergeLinkedFragments, splitDisconnected, type Clusterer } from "./clusterer.ts";

/**
 * Adapter for ngraph.leiden, chosen in the phase 1 spike because it runs in
 * workerd, is deterministic for a fixed seed and honours edge weights under CPM.
 *
 * It runs with `refine: false`. Measured on the reference networks and the
 * weighted fixtures, the library's refinement phase makes results worse: karate
 * club modularity falls from 0.415 to 0.364 (best known 0.4198) and no CPM
 * gamma recovers five planted stories, while without it gamma 0.25 recovers all
 * five. Without refinement this is Louvain-style optimisation, so connected
 * communities are restored afterwards by `splitDisconnected`.
 *
 * CPM is a density threshold, and the neighbour cap keeps a large burst sparse,
 * so CPM alone cuts a 300-claim story into dozens of pieces at any gamma that
 * still separates stories glued by a popular entity. `mergeLinkedFragments`
 * rejoins those pieces by link strength; see its comment for the rule.
 *
 * Nodes and edges are inserted in id order so the library never sees an order
 * that depends on the caller.
 */
export const leidenClusterer: Clusterer = {
  cluster(nodes, edges, options) {
    const graph = createGraph();
    for (const node of [...new Set(nodes)].sort((a, b) => a - b)) graph.addNode(node);
    const ordered = edges
      .map((edge) => (edge.claimA < edge.claimB ? edge : { claimA: edge.claimB, claimB: edge.claimA, weight: edge.weight }))
      .sort((a, b) => a.claimA - b.claimA || a.claimB - b.claimB);
    for (const edge of ordered) {
      if (edge.claimA === edge.claimB || !graph.hasNode(edge.claimA) || !graph.hasNode(edge.claimB)) continue;
      graph.addLink(edge.claimA, edge.claimB, { weight: edge.weight });
    }
    if (graph.getNodeCount() === 0) return { communities: [], singletons: [], quality: 0 };

    const clusters = detectClusters(graph, { quality: options.quality, resolution: options.resolution, randomSeed: options.seed, refine: false });
    const assignment = new Map<number, number>();
    graph.forEachNode((node) => void assignment.set(node.id as number, clusters.getClass(node.id)));
    const connected = splitDisconnected(assignment, ordered);
    return canonicalClustering(mergeLinkedFragments(connected, ordered), options.minCommunitySize, clusters.quality());
  },
};
