declare module "ngraph.leiden" {
  import type { Graph, Link, Node, NodeId } from "ngraph.graph";

  export interface DetectClustersOptions {
    quality?: "modularity" | "cpm";
    resolution?: number;
    randomSeed?: number;
    directed?: boolean;
    linkWeight?: (link: Link) => number;
    nodeSize?: (node: Node) => number;
    refine?: boolean;
    maxLevels?: number;
    maxLocalPasses?: number;
  }

  export interface Clusters {
    getClass(nodeId: NodeId): number;
    getCommunities(): Map<number, NodeId[]>;
    quality(): number;
  }

  export function detectClusters(graph: Graph, options?: DetectClustersOptions): Clusters;
}
