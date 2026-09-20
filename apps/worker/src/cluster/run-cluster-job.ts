import { PARAMS_VERSION, resolveParams } from "@radar/core";
import { getSetting } from "../db/settings-repo";
import { clusterStep } from "./cluster-step";
import { cosineEdgesStep } from "./cosine-edges-step";
import { deriveRelationsStep } from "./derive-relations-step";
import { embedClaimsStep } from "./embed-claims-step";
import { workersAiEmbedder, type EmbedFn } from "./embedding-client";
import { enqueueSynthesisStep } from "./enqueue-synthesis-step";
import { finalizeStep } from "./finalize-step";
import type { ClusterEnv, JobContext } from "./job-context";
import { acquireLease, CLUSTER_LEASE, releaseLeaseStatement, renewLease } from "./job-lease";
import { lineageStep } from "./lineage-step";
import { resolveEntitiesStep } from "./resolve-entities-step";
import { scoreStep } from "./score-step";

export interface ClusterJobDeps {
  now?: number;
  embed?: EmbedFn;
  /** Test hook: called when a stage begins, and may throw to simulate the job dying there. */
  onStage?: (stage: string) => void | Promise<void>;
}

export type ClusterJobResult = { status: "skipped"; reason: "lease_held" } | { status: "done"; runId: number; communities: number; synthesisQueued: number };

class LeaseLost extends Error {}

/**
 * Hourly job: claims in, scored stories out. Steps are named and recorded in
 * `cluster_runs.stage`; the lease is renewed after each one. Everything before the
 * publish is staged under the run id and invisible; the publish itself is one D1
 * transaction (see finalize-step.ts).
 */
export async function runClusterJob(env: ClusterEnv, deps: ClusterJobDeps = {}): Promise<ClusterJobResult> {
  const db = env.DB;
  const now = deps.now ?? Math.floor(Date.now() / 1000);
  const holder = crypto.randomUUID();
  if (!(await acquireLease(db, CLUSTER_LEASE, holder, now))) return { status: "skipped", reason: "lease_held" };

  // Holding the lease proves any run still marked `running` is dead.
  await db.prepare("UPDATE cluster_runs SET status = 'failed', error = COALESCE(error, 'lease expired'), finished_at = ? WHERE status = 'running'").bind(now).run();
  const params = resolveParams((await getSetting<Record<string, unknown>>(db, "core_overrides")) ?? {});
  const lastDone = await db.prepare("SELECT MAX(started_at) AS at FROM cluster_runs WHERE status = 'done'").first<{ at: number | null }>();
  const run = await db
    .prepare("INSERT INTO cluster_runs (started_at, heartbeat_at, stage, params_json, seed) VALUES (?, ?, 'acquire_lease', ?, ?) RETURNING id")
    .bind(now, now, JSON.stringify({ version: PARAMS_VERSION, params }), params.seed)
    .first<{ id: number }>();

  let tokens = 0;
  const ctx: JobContext = {
    env, db, runId: run!.id, holder, now, params, lastDoneRunStartedAt: lastDone?.at ?? 0,
    embed: deps.embed ?? workersAiEmbedder(env.AI, (count) => void (tokens += count)),
  };
  const stage = async <T>(name: string, work: () => Promise<T>): Promise<T> => {
    await db.prepare("UPDATE cluster_runs SET stage = ?, heartbeat_at = ? WHERE id = ?").bind(name, now, ctx.runId).run();
    await deps.onStage?.(name);
    const result = await work();
    if (!(await renewLease(db, CLUSTER_LEASE, holder, now))) throw new LeaseLost(`lease lost after ${name}`);
    return result;
  };

  try {
    await stage("resolve_entities", () => resolveEntitiesStep(ctx));
    await stage("embed_claims", () => embedClaimsStep(ctx));
    await stage("derive_relations", () => deriveRelationsStep(ctx));
    const { vectors } = await stage("cosine_edges", () => cosineEdgesStep(ctx));
    const cluster = await stage("cluster", () => clusterStep(ctx, vectors));
    const lineage = await stage("lineage", () => lineageStep(ctx, cluster));
    const stories = await stage("score", () => scoreStep(ctx, cluster, lineage));
    await db.prepare("UPDATE cluster_runs SET stage = 'finalize', heartbeat_at = ? WHERE id = ?").bind(now, ctx.runId).run();
    await deps.onStage?.("finalize");
    await finalizeStep(ctx, cluster, lineage, stories, () => deps.onStage?.("publish"));
    const synthesisQueued = await enqueueSynthesisStep(ctx);
    console.log(JSON.stringify({ event: "cluster_run", runId: ctx.runId, claims: cluster.claims.length, communities: cluster.communities.length, embeddedTokens: tokens, synthesisQueued }));
    return { status: "done", runId: ctx.runId, communities: cluster.communities.length, synthesisQueued };
  } catch (err) {
    const message = err instanceof Error ? `${err.name}: ${err.message}`.slice(0, 500) : "unknown_error";
    await db.prepare("UPDATE cluster_runs SET status = 'failed', error = ?, finished_at = ? WHERE id = ? AND status = 'running'").bind(message, now, ctx.runId).run();
    if (!(err instanceof LeaseLost)) await releaseLeaseStatement(db, CLUSTER_LEASE, holder).run();
    throw err;
  }
}
