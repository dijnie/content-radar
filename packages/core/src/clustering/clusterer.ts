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

/** Two fragments are one story when the links between them are at least this strong relative to the links inside them. */
const FRAGMENT_LINK_STRENGTH = 0.9;

/**
 * Rejoins fragments of one large story. The neighbour cap keeps a burst of
 * hundreds of near-identical claims sparse, so a density-based quality function
 * such as CPM cuts it into dense pieces. Density cannot tell those pieces from
 * unrelated stories glued by a popular entity, but link strength can: between
 * fragments of one burst the edges are as strong as inside them, while glue
 * edges barely clear the minimum weight. Two communities are joined when they
 * share at least as many edges as the smaller one has members and the mean
 * weight of those edges reaches 90% of the weaker community's internal mean.
 */
export function mergeLinkedFragments(assignment: ReadonlyMap<number, number>, edges: readonly WeightedEdge[]): Map<number, number> {
  const size = new Map<number, number>();
  for (const label of assignment.values()) size.set(label, (size.get(label) ?? 0) + 1);
  const internal = new Map<number, { sum: number; count: number }>();
  const between = new Map<string, { a: number; b: number; sum: number; count: number }>();
  for (const { claimA, claimB, weight } of edges) {
    const labelA = assignment.get(claimA);
    const labelB = assignment.get(claimB);
    if (labelA === undefined || labelB === undefined) continue;
    if (labelA === labelB) {
      const entry = internal.get(labelA) ?? { sum: 0, count: 0 };
      internal.set(labelA, { sum: entry.sum + weight, count: entry.count + 1 });
      continue;
    }
    const [a, b] = labelA < labelB ? [labelA, labelB] : [labelB, labelA];
    const entry = between.get(`${a}:${b}`) ?? { a, b, sum: 0, count: 0 };
    between.set(`${a}:${b}`, { a, b, sum: entry.sum + weight, count: entry.count + 1 });
  }

  const parent = new Map<number, number>([...size.keys()].map((label) => [label, label]));
  const find = (label: number): number => {
    let root = label;
    while (parent.get(root) !== root) root = parent.get(root)!;
    parent.set(label, root);
    return root;
  };
  for (const link of [...between.values()].sort((x, y) => x.a - y.a || x.b - y.b)) {
    const inA = internal.get(link.a);
    const inB = internal.get(link.b);
    // Only real communities take part; a lone claim has no internal links to compare with.
    if (!inA || !inB) continue;
    const enoughLinks = link.count >= Math.min(size.get(link.a)!, size.get(link.b)!);
    const strongLinks = link.sum / link.count >= FRAGMENT_LINK_STRENGTH * Math.min(inA.sum / inA.count, inB.sum / inB.count);
    if (enoughLinks && strongLinks) {
      const rootA = find(link.a);
      const rootB = find(link.b);
      if (rootA !== rootB) parent.set(Math.max(rootA, rootB), Math.min(rootA, rootB));
    }
  }
  return new Map([...assignment].map(([node, label]) => [node, find(label)]));
}

/** Stable fingerprint of a partition, for determinism checks and `members_hash`-style comparisons. */
export function partitionKey(clustering: Pick<Clustering, "communities" | "singletons">): string {
  return `${clustering.communities.map((members) => members.join(",")).join("|")}#${clustering.singletons.join(",")}`;
}
