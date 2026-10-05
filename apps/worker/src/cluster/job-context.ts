import type { CoreParams, VectorMatrix } from "@radar/core";
import type { Env } from "../env";
import type { EmbedFn } from "./embedding-client";

export type ClusterEnv = Pick<Env, "DB" | "AI" | "LLM_QUEUE" | "LLM_MODEL">;

export interface JobContext {
  env: ClusterEnv;
  db: D1Database;
  runId: number;
  holder: string;
  now: number;
  params: CoreParams;
  embed: EmbedFn;
  /** Start of the most recent finished run; claims embedded since then still need their neighbours. */
  lastDoneRunStartedAt: number;
}

export interface WindowClaim {
  id: number;
  itemId: number;
  authorId: number | null;
  publishedAt: number;
  kind: "measurement" | "experience" | "announcement" | "report" | "opinion";
  hasNumbers: boolean;
  firstHand: boolean;
  textVi: string;
  topics: string[];
  derivedFromClaimId: number | null;
}

export interface CommunityDraft {
  index: number;
  members: number[];
  signature: number[];
}

export interface ClusterOutput {
  claims: WindowClaim[];
  communities: CommunityDraft[];
  entityIdsByClaim: Map<number, number[]>;
  idf: ReadonlyMap<number, number>;
  velocityZByClaim: Map<number, number | null>;
  edgeCount: number;
  quality: number;
  vectors: VectorMatrix;
}

export function windowStart(ctx: Pick<JobContext, "now" | "params">): number {
  return ctx.now - ctx.params.windowDays * 86_400;
}
