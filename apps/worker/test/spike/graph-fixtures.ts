export type WeightedEdge = [source: number, target: number, weight: number];

// Zachary's karate club, 34 nodes and 78 undirected edges, 0-indexed.
export const KARATE_CLUB_EDGES: [number, number][] = [
  [0, 1], [0, 2], [0, 3], [0, 4], [0, 5], [0, 6], [0, 7], [0, 8], [0, 10], [0, 11], [0, 12], [0, 13],
  [0, 17], [0, 19], [0, 21], [0, 31], [1, 2], [1, 3], [1, 7], [1, 13], [1, 17], [1, 19], [1, 21], [1, 30],
  [2, 3], [2, 7], [2, 8], [2, 9], [2, 13], [2, 27], [2, 28], [2, 32], [3, 7], [3, 12], [3, 13], [4, 6],
  [4, 10], [5, 6], [5, 10], [5, 16], [6, 16], [8, 30], [8, 32], [8, 33], [9, 33], [13, 33], [14, 32],
  [14, 33], [15, 32], [15, 33], [18, 32], [18, 33], [19, 33], [20, 32], [20, 33], [22, 32], [22, 33],
  [23, 25], [23, 27], [23, 29], [23, 32], [23, 33], [24, 25], [24, 27], [24, 31], [25, 31], [26, 29],
  [26, 33], [27, 33], [28, 31], [28, 33], [29, 32], [29, 33], [30, 32], [30, 33], [31, 32], [31, 33],
  [32, 33],
];

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const PLANTED_CLUSTERS = 5;
export const PLANTED_CLUSTER_SIZE = 10;
export const PLANTED_NODES = PLANTED_CLUSTERS * PLANTED_CLUSTER_SIZE;

export function plantedCluster(node: number): number {
  return Math.floor(node / PLANTED_CLUSTER_SIZE);
}

/**
 * Complete graph over five planted clusters. Topology carries no structure at
 * all, so the clusters are recoverable only by an algorithm that honours edge
 * weights: intra-cluster weights sit near 0.9, inter-cluster near 0.05.
 */
export function plantedCompleteGraph(seed: number): WeightedEdge[] {
  const random = mulberry32(seed);
  const edges: WeightedEdge[] = [];
  for (let i = 0; i < PLANTED_NODES; i++) {
    for (let j = i + 1; j < PLANTED_NODES; j++) {
      const base = plantedCluster(i) === plantedCluster(j) ? 0.9 : 0.05;
      edges.push([i, j, base + (random() - 0.5) * 0.04]);
    }
  }
  return edges;
}

/** Canonical form of a partition: sorted member lists, independent of labels. */
export function canonicalPartition(assignment: ArrayLike<number>): string {
  const groups = new Map<number, number[]>();
  for (let node = 0; node < assignment.length; node++) {
    const label = assignment[node]!;
    const members = groups.get(label);
    if (members) members.push(node);
    else groups.set(label, [node]);
  }
  return [...groups.values()]
    .map((members) => members.join(","))
    .sort()
    .join("|");
}

export function plantedPartition(): string {
  return canonicalPartition(Array.from({ length: PLANTED_NODES }, (_, node) => plantedCluster(node)));
}
