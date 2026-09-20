import type { WeightedEdge } from "../graph/weighted-edges.ts";
import type { Clusterer, ClusterOptions } from "./clusterer.ts";

export interface SweepPoint {
  resolution: number;
  communities: number;
  singletons: number;
  largestCommunity: number;
}

export interface SweepResult {
  points: SweepPoint[];
  /** Longest run of consecutive resolutions that agree on the number of communities. */
  stableRange: { from: number; to: number; communities: number } | null;
  /** Middle of the stable range: the least sensitive choice. */
  recommended: number | null;
}

/**
 * CPM's gamma is a density threshold in the same unit as the edge weights, so
 * the usable band depends on the data. The sweep runs the clusterer across a
 * grid and recommends the centre of the widest plateau in community count,
 * ignoring the degenerate ends where everything merges or nothing holds.
 */
export function resolutionSweep(clusterer: Clusterer, nodes: readonly number[], edges: readonly WeightedEdge[], resolutions: readonly number[], options: Omit<ClusterOptions, "resolution">): SweepResult {
  const grid = [...resolutions].sort((a, b) => a - b);
  const points = grid.map((resolution): SweepPoint => {
    const { communities, singletons } = clusterer.cluster(nodes, edges, { ...options, resolution });
    return { resolution, communities: communities.length, singletons: singletons.length, largestCommunity: Math.max(0, ...communities.map((members) => members.length)) };
  });

  let best: { start: number; end: number } | null = null;
  for (let start = 0; start < points.length; ) {
    let end = start;
    while (end + 1 < points.length && points[end + 1]!.communities === points[start]!.communities) end++;
    const meaningful = points[start]!.communities > 1;
    if (meaningful && (!best || end - start > best.end - best.start)) best = { start, end };
    start = end + 1;
  }
  if (!best) return { points, stableRange: null, recommended: null };
  const from = points[best.start]!.resolution;
  const to = points[best.end]!.resolution;
  return { points, stableRange: { from, to, communities: points[best.start]!.communities }, recommended: grid[Math.floor((best.start + best.end) / 2)]! };
}
