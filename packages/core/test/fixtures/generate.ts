import type { WeightedEdge } from "../../src/index";

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

export interface GraphFixture {
  nodes: number[];
  edges: WeightedEdge[];
  /** Planted story of each node, or -1 for noise. */
  truth: Map<number, number>;
}

function addEdge(edges: WeightedEdge[], a: number, b: number, weight: number): void {
  edges.push({ claimA: Math.min(a, b), claimB: Math.max(a, b), weight: Math.min(1, Math.max(0, weight)) });
}

/**
 * Five stories of twelve claims that all mention one popular entity. Inside a
 * story the edges are strong; across stories the shared entity still produces
 * many weak edges, which is exactly the glue a hub entity creates.
 */
export function syntheticStories(seed = 11): GraphFixture {
  const random = mulberry32(seed);
  const nodes: number[] = [];
  const truth = new Map<number, number>();
  const edges: WeightedEdge[] = [];
  for (let story = 0; story < 5; story++) for (let k = 0; k < 12; k++) (nodes.push(story * 12 + k + 1), truth.set(story * 12 + k + 1, story));
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const same = truth.get(nodes[i]!) === truth.get(nodes[j]!);
      if (same && random() < 0.7) addEdge(edges, nodes[i]!, nodes[j]!, 0.72 + random() * 0.2);
      else if (!same && random() < 0.35) addEdge(edges, nodes[i]!, nodes[j]!, 0.45 + random() * 0.06);
    }
  }
  return { nodes, edges, truth };
}

/**
 * Shaped like real short-post data: 70% isolated claims, a handful of small
 * clusters, and one burst of 300 near-identical claims capped at 30 neighbours each.
 */
export function sparseSocial(seed = 23): GraphFixture {
  const random = mulberry32(seed);
  const nodes: number[] = [];
  const truth = new Map<number, number>();
  const edges: WeightedEdge[] = [];
  let next = 1;
  const group = (size: number, story: number, link: (members: number[]) => void) => {
    const members = Array.from({ length: size }, () => next++);
    for (const member of members) (nodes.push(member), truth.set(member, story));
    link(members);
  };
  // The burst: each claim links to its 30 nearest in id order, the way the neighbour cap shapes it.
  group(300, 0, (members) => {
    for (let i = 0; i < members.length; i++) for (let j = i + 1; j <= i + 15 && j < members.length; j++) addEdge(edges, members[i]!, members[j]!, 0.8 + random() * 0.15);
  });
  for (let story = 1; story <= 12; story++) {
    group(3 + Math.floor(random() * 5), story, (members) => {
      for (let i = 0; i < members.length; i++) for (let j = i + 1; j < members.length; j++) if (random() < 0.8) addEdge(edges, members[i]!, members[j]!, 0.6 + random() * 0.3);
    });
  }
  const clustered = nodes.length;
  const isolated = Math.round((clustered / 0.3) * 0.7);
  for (let k = 0; k < isolated; k++) (nodes.push(next), truth.set(next++, -1));
  // A little noise: weak stray edges between unrelated claims.
  for (let k = 0; k < 40; k++) {
    const a = nodes[Math.floor(random() * nodes.length)]!;
    const b = nodes[Math.floor(random() * nodes.length)]!;
    if (a !== b && truth.get(a) !== truth.get(b)) addEdge(edges, a, b, 0.45 + random() * 0.04);
  }
  return { nodes, edges, truth };
}

/**
 * A burst of 300 claims joined the way the neighbour cap joins them (each picks
 * 30 of the others), 40 stories of five claims, 600 isolated claims, and weak
 * hub-entity edges between unrelated stories and into the burst.
 */
export function knnBurst(seed = 3): GraphFixture {
  const random = mulberry32(seed);
  const truth = new Map<number, number>();
  const edges: WeightedEdge[] = [];
  const seen = new Set<string>();
  const link = (a: number, b: number, weight: number) => {
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    if (a === b || seen.has(key)) return;
    seen.add(key);
    addEdge(edges, a, b, weight);
  };
  for (let node = 1; node <= 300; node++) truth.set(node, 0);
  for (let node = 1; node <= 300; node++) for (let k = 0; k < 30; k++) link(node, 1 + Math.floor(random() * 300), 0.55 + random() * 0.05);
  let next = 301;
  for (let story = 1; story <= 40; story++) {
    const members = Array.from({ length: 5 }, () => next++);
    for (const member of members) truth.set(member, story);
    for (const a of members) for (const b of members) if (a < b) link(a, b, 0.55 + random() * 0.05);
  }
  for (let k = 0; k < 600; k++) truth.set(next++, -1);
  for (let k = 0; k < 60; k++) {
    const a = 301 + Math.floor(random() * 200);
    const b = random() < 0.5 ? 1 + Math.floor(random() * 300) : 301 + Math.floor(random() * 200);
    if (truth.get(a) !== truth.get(b)) link(a, b, 0.45 + random() * 0.03);
  }
  return { nodes: [...truth.keys()], edges, truth };
}

/** Newman modularity of a partition on an unweighted or weighted edge list. */
export function modularity(edges: readonly WeightedEdge[], communityOf: ReadonlyMap<number, number>): number {
  let total = 0;
  const degree = new Map<number, number>();
  const internal = new Map<number, number>();
  for (const { claimA, claimB, weight } of edges) {
    total += weight;
    degree.set(claimA, (degree.get(claimA) ?? 0) + weight);
    degree.set(claimB, (degree.get(claimB) ?? 0) + weight);
    const community = communityOf.get(claimA);
    if (community !== undefined && community === communityOf.get(claimB)) internal.set(community, (internal.get(community) ?? 0) + weight);
  }
  const degreeSum = new Map<number, number>();
  for (const [node, value] of degree) {
    const community = communityOf.get(node);
    if (community !== undefined) degreeSum.set(community, (degreeSum.get(community) ?? 0) + value);
  }
  let q = 0;
  for (const [community, sum] of degreeSum) q += (internal.get(community) ?? 0) / total - (sum / (2 * total)) ** 2;
  return q;
}
