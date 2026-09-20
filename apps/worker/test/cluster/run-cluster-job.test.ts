import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { ClusterEnv } from "../../src/cluster/job-context";
import { runClusterJob } from "../../src/cluster/run-cluster-job";
import { fakeEmbedder, fakeLlmQueue, seedClaims, wipeClusterState, type SeedClaim } from "./seed-claims";

const HOUR = 3600;
const T0 = Date.UTC(2026, 8, 20, 12, 5, 0) / 1000;

let llm: ReturnType<typeof fakeLlmQueue>;
let testEnv: ClusterEnv;

beforeEach(async () => {
  await wipeClusterState(env.DB);
  await env.DB.prepare("UPDATE llm_models SET rpd = 1000, rpm = 1000, exhausted_until = NULL").run();
  llm = fakeLlmQueue();
  testEnv = { DB: env.DB, AI: env.AI, LLM_QUEUE: llm.queue };
});

const stories = async () =>
  (await env.DB.prepare("SELECT id, alive, status, independent_sources, headline_vi, headline_source, user_state, members_hash FROM stories WHERE alive = 1 ORDER BY id").all<Record<string, unknown>>()).results;
const membersOf = async (storyId: number) =>
  (await env.DB.prepare("SELECT claim_id FROM story_claims WHERE story_id = ? AND active = 1 ORDER BY claim_id").bind(storyId).all<{ claim_id: number }>()).results.map((row) => row.claim_id);
const events = async (runId: number) =>
  (await env.DB.prepare("SELECT type, COUNT(*) AS n FROM lineage_events WHERE run_id = ? GROUP BY type ORDER BY type").bind(runId).all<{ type: string; n: number }>()).results;

function fiveStoriesAndNoise(): SeedClaim[] {
  const specs: SeedClaim[] = [];
  for (let story = 1; story <= 5; story++) for (let k = 0; k < 12; k++) specs.push({ tag: `S${story}`, publishedAt: T0 - (k + 1) * HOUR, hasNumbers: k === 0 });
  for (let k = 0; k < 100; k++) specs.push({ tag: null, publishedAt: T0 - (k % 48) * HOUR });
  return specs;
}

describe("runClusterJob", () => {
  it("turns 60 clustered and 100 isolated claims into five stories, and a second run changes nothing", async () => {
    const claimIds = await seedClaims(env.DB, fiveStoriesAndNoise());
    const embedder = fakeEmbedder();

    const first = await runClusterJob(testEnv, { now: T0, embed: embedder.embed });
    expect(first).toMatchObject({ status: "done", communities: 5 });
    const afterFirst = await stories();
    expect(afterFirst).toHaveLength(5);
    for (const story of afterFirst) {
      expect(await membersOf(story.id as number)).toHaveLength(12);
      // Twelve authors, no derivation: plenty of independent sources.
      expect(story).toMatchObject({ status: "ready", independent_sources: 12, headline_source: "fallback" });
      expect(String(story.headline_vi)).toMatch(/^Nhận định S\d số \d+/);
    }
    // No isolated claim became a story.
    const inStories = new Set((await Promise.all(afterFirst.map((story) => membersOf(story.id as number)))).flat());
    expect(claimIds.slice(60).some((id) => inStories.has(id))).toBe(false);
    expect(embedder.texts).toHaveLength(160);
    expect(await events(first.status === "done" ? first.runId : 0)).toEqual([{ type: "birth", n: 5 }]);

    const second = await runClusterJob(testEnv, { now: T0 + HOUR, embed: embedder.embed });
    expect(second).toMatchObject({ status: "done", communities: 5 });
    expect(embedder.texts).toHaveLength(160);
    expect((await stories()).map((story) => [story.id, story.members_hash])).toEqual(afterFirst.map((story) => [story.id, story.members_hash]));
    expect(await events(second.status === "done" ? second.runId : 0)).toEqual([{ type: "continue", n: 5 }]);

    const run = await env.DB.prepare("SELECT status, stage, node_count, community_count, params_json FROM cluster_runs WHERE id = ?").bind(second.status === "done" ? second.runId : 0).first<Record<string, unknown>>();
    expect(run).toMatchObject({ status: "done", stage: "done", node_count: 160, community_count: 5 });
    expect(JSON.parse(String(run!.params_json))).toMatchObject({ version: 1, params: { resolution: 0.25, seed: 42, quality: "cpm" } });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM job_leases").first()).toEqual({ n: 0 });
  });

  it("skips when another run holds the lease", async () => {
    await env.DB.prepare("INSERT INTO job_leases (name, holder, expires_at) VALUES ('cluster', 'someone-else', ?)").bind(T0 + 600).run();
    expect(await runClusterJob(testEnv, { now: T0, embed: fakeEmbedder().embed })).toEqual({ status: "skipped", reason: "lease_held" });
  });

  it.each(["lineage", "score", "finalize"])("a job that dies during %s costs no story its id or its user state", async (dyingStage) => {
    await seedClaims(env.DB, fiveStoriesAndNoise().slice(0, 60));
    const embedder = fakeEmbedder();
    await runClusterJob(testEnv, { now: T0, embed: embedder.embed });
    const before = await stories();
    await env.DB.prepare("UPDATE stories SET user_state = 'saved', user_state_at = ? WHERE id = ?").bind(T0, before[0]!.id).run();

    await expect(
      runClusterJob(testEnv, { now: T0 + HOUR, embed: embedder.embed, onStage: (stage) => { if (stage === dyingStage) throw new Error("worker evicted"); } }),
    ).rejects.toThrow("worker evicted");
    expect(await env.DB.prepare("SELECT status FROM cluster_runs ORDER BY id DESC LIMIT 1").first()).toEqual({ status: "failed" });

    const recovered = await runClusterJob(testEnv, { now: T0 + 2 * HOUR, embed: embedder.embed });
    expect(recovered.status).toBe("done");
    const after = await stories();
    expect(after.map((story) => story.id)).toEqual(before.map((story) => story.id));
    expect(after[0]).toMatchObject({ user_state: "saved" });
    // The half-written run produced no birth and no death; the recovery run only continues.
    expect(await events(recovered.status === "done" ? recovered.runId : 0)).toEqual([{ type: "continue", n: 5 }]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM lineage_events e JOIN cluster_runs r ON r.id = e.run_id WHERE r.status = 'done' AND e.type IN ('birth', 'death')").first()).toEqual({ n: 5 });
  });

  it("takes over an expired lease and marks the run it belonged to as failed", async () => {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO cluster_runs (started_at, heartbeat_at, params_json, seed) VALUES (?, ?, '{}', 42)").bind(T0 - 3 * HOUR, T0 - 3 * HOUR),
      env.DB.prepare("INSERT INTO job_leases (name, holder, expires_at) VALUES ('cluster', 'dead-worker', ?)").bind(T0 - HOUR),
    ]);
    await seedClaims(env.DB, [{ tag: "S1", publishedAt: T0 - HOUR }, { tag: "S1", publishedAt: T0 - 2 * HOUR }]);
    expect((await runClusterJob(testEnv, { now: T0, embed: fakeEmbedder().embed })).status).toBe("done");
    const runs = (await env.DB.prepare("SELECT status, error FROM cluster_runs ORDER BY id").all()).results;
    expect(runs).toEqual([{ status: "failed", error: "lease expired" }, { status: "done", error: null }]);
  });
});
