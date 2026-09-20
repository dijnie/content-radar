import type { WeightedEdge } from "../graph/weighted-edges.ts";
import type { CoreParams } from "../params.ts";

export type ClusterOptions = Pick<CoreParams, "seed" | "resolution" | "quality" | "minCommunitySize">;

export interface Clustering {
  /** Communities of at least `minCommunitySize` claims: members ascending, communities ordered by their smallest member. */
  communities: number[][];
  /** Claims left alone or in a community below the minimum size, ascending. */
  singletons: number[];
  /** Value of the quality function the library optimised. */
  quality: number;
}

/** The clustering library sits behind this interface, so replacing it touches one file. */
export interface Clusterer {
  cluster(nodes: readonly number[], edges: readonly WeightedEdge[], options: ClusterOptions): Clustering;
}

/**
 * Turns a raw node -> label assignment into the canonical result. Labels carry
 * no meaning, so communities are identified by their smallest member.
 */
export function canonicalClustering(assignment: ReadonlyMap<number, number>, minCommunitySize: number, quality: number): Clustering {
  const groups = new Map<number, number[]>();
  for (const [node, label] of assignment) {
    const members = groups.get(label);
    if (members) members.push(node);
    else groups.set(label, [node]);
  }
  const communities: number[][] = [];
  const singletons: number[] = [];
  for (const members of groups.values()) {
    members.sort((a, b) => a - b);
    if (members.length >= minCommunitySize) communities.push(members);
    else singletons.push(...members);
  }
  communities.sort((a, b) => a[0]! - b[0]!);
  singletons.sort((a, b) => a - b);
  return { communities, singletons, quality };
}

/**
 * Splits every community into its connected components over the given edges.
 * The clustering runs without Leiden's refinement phase, which is the phase
 * that guarantees connected communities, so the guarantee is restored here.
 */
export function splitDisconnected(assignment: ReadonlyMap<number, number>, edges: readonly WeightedEdge[]): Map<number, number> {
  const parent = new Map<number, number>();
  const find = (node: number): number => {
    let root = node;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let current = node;
    while (parent.get(current) !== root) {
      const next = parent.get(current)!;
      parent.set(current, root);
      current = next;
    }
    return root;
  };
  for (const node of assignment.keys()) parent.set(node, node);
  for (const { claimA, claimB } of edges) {
    const labelA = assignment.get(claimA);
    if (labelA === undefined || labelA !== assignment.get(claimB)) continue;
    const rootA = find(claimA);
    const rootB = find(claimB);
    // The smaller id becomes the root, which keeps the result independent of edge order.
    if (rootA !== rootB) parent.set(Math.max(rootA, rootB), Math.min(rootA, rootB));
  }
  return new Map([...assignment.keys()].map((node) => [node, find(node)]));
}

/** Stable fingerprint of a partition, for determinism checks and `members_hash`-style comparisons. */
export function partitionKey(clustering: Pick<Clustering, "communities" | "singletons">): string {
  return `${clustering.communities.map((members) => members.join(",")).join("|")}#${clustering.singletons.join(",")}`;
}
