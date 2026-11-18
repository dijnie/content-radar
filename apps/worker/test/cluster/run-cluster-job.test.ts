import { seedAi } from "../db/seed-ai";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClusterEnv } from "../../src/cluster/job-context";
import { runClusterJob } from "../../src/cluster/run-cluster-job";
import { fakeEmbedder, fakeLlmQueue, seedClaims, wipeClusterState, type SeedClaim } from "./seed-claims";

const HOUR = 3600;
const T0 = Date.UTC(2026, 8, 20, 12, 5, 0) / 1000;

let llm: ReturnType<typeof fakeLlmQueue>;
let testEnv: ClusterEnv;

afterEach(() => vi.useRealTimers());

beforeEach(async () => {
  await wipeClusterState(env.DB);
  await env.DB.prepare("UPDATE llm_models SET rpd = 1000, rpm = 1000, exhausted_until = NULL").run();
  llm = fakeLlmQueue();
  testEnv = { DB: env.DB, LLM_QUEUE: llm.queue };
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

  it("refreshes cached vectors when the model or endpoint changes and removes obsolete cosine edges", async () => {
    const ids = await seedClaims(env.DB, [
      { tag: "S1", publishedAt: T0, entity: "example entity" }, { tag: "S1", publishedAt: T0 },
    ]);
    await seedAi(env.DB, { embeddingModel: "@cf/baai/bge-m3" });
    await runClusterJob(testEnv, { now: T0, embed: fakeEmbedder().embed });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM claim_edges").first()).toEqual({ n: 1 });
    await seedAi(env.DB, { embeddingModel: "new-model" });
    const orthogonal = fakeEmbedder();
    const embed = (texts: readonly string[]) => orthogonal.embed(texts.map(t => "unrelated " + t));
    await runClusterJob(testEnv, { now: T0 + HOUR, embed });
    expect(orthogonal.texts).toHaveLength(3);
    const refreshed = await env.DB.prepare("SELECT claim_id FROM claim_embeddings WHERE model LIKE 'new-model@%' ORDER BY claim_id").all();
    expect(refreshed.results.map(row => row.claim_id)).toEqual(ids);
    expect(await env.DB.prepare("SELECT model FROM entity_embeddings").first()).toEqual({ model: expect.stringMatching(/^new-model@/) });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM claim_edges").first()).toEqual({ n: 0 });
    await runClusterJob(testEnv, { now: T0 + 2 * HOUR, embed });
    expect(orthogonal.texts).toHaveLength(3);
    const previous = await env.DB.prepare("SELECT model FROM entity_embeddings").first<string>("model");
    await seedAi(env.DB, { embeddingModel: "new-model", endpoint: "https://other.example/v1" });
    await runClusterJob(testEnv, { now: T0 + 3 * HOUR, embed });
    expect(orthogonal.texts).toHaveLength(6);
    expect(await env.DB.prepare("SELECT model FROM entity_embeddings").first<string>("model")).not.toBe(previous);
  });

  it("skips when another run holds the lease", async () => {
    await env.DB.prepare("INSERT INTO job_leases (name, holder, expires_at) VALUES ('cluster', 'someone-else', ?)").bind(T0 + 600).run();
    expect(await runClusterJob(testEnv, { now: T0, embed: fakeEmbedder().embed })).toEqual({ status: "skipped", reason: "lease_held" });
  });

  // "publish" fires inside finalizeStep, after staging and right before the single publishing transaction.
  it.each(["lineage", "score", "finalize", "publish"])("a job that dies during %s costs no story its id or its user state", async (dyingStage) => {
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

  it("moves the heartbeat and the lease expiry with the wall clock while the run is in progress", async () => {
    await seedClaims(env.DB, [{ tag: "S1", publishedAt: T0 - HOUR }, { tag: "S1", publishedAt: T0 - 2 * HOUR }]);
    vi.useFakeTimers({ toFake: ["Date"] });
    const seen: { stage: string; heartbeat: number; leaseExpires: number }[] = [];
    await runClusterJob(testEnv, {
      now: T0,
      embed: fakeEmbedder().embed,
      onStage: async (stage) => {
        const row = await env.DB.prepare("SELECT (SELECT heartbeat_at FROM cluster_runs ORDER BY id DESC LIMIT 1) AS heartbeat, (SELECT expires_at FROM job_leases WHERE name = 'cluster') AS leaseExpires").first<{ heartbeat: number; leaseExpires: number }>();
        seen.push({ stage, ...row! });
        vi.advanceTimersByTime(20 * 60 * 1000); // every stage "takes" twenty minutes
      },
    });
    const first = seen.find((entry) => entry.stage === "resolve_entities")!;
    const late = seen.find((entry) => entry.stage === "score")!;
    expect(late.heartbeat - first.heartbeat).toBe(6 * 20 * 60);
    expect(late.leaseExpires - first.leaseExpires).toBe(6 * 20 * 60);
    // Two hours of work on a 75-minute lease, and the run still finished as its holder.
    expect(await env.DB.prepare("SELECT status FROM cluster_runs ORDER BY id DESC LIMIT 1").first()).toEqual({ status: "done" });
  });

  it.each(["cluster", "finalize", "publish"])("stops writing when another run takes the lease during %s", async (lostAt) => {
    await seedClaims(env.DB, [{ tag: "S1", publishedAt: T0 - HOUR }, { tag: "S1", publishedAt: T0 - 2 * HOUR }]);
    await expect(
      runClusterJob(testEnv, { now: T0, embed: fakeEmbedder().embed, onStage: async (stage) => { if (stage === lostAt) await env.DB.prepare("UPDATE job_leases SET holder = 'someone-else' WHERE name = 'cluster'").run(); } }),
    ).rejects.toThrow(/lease lost/);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM stories WHERE alive = 1").first()).toEqual({ n: 0 });
    // The new holder's lease is left alone.
    expect(await env.DB.prepare("SELECT holder FROM job_leases WHERE name = 'cluster'").first()).toEqual({ holder: "someone-else" });
  });

  it("preserves published stories if the lease changes after the final check but before the transaction", async () => {
    const embedder = fakeEmbedder();
    await seedClaims(env.DB, [{ tag: "S1", publishedAt: T0 - HOUR }, { tag: "S1", publishedAt: T0 - 2 * HOUR }]);
    await runClusterJob(testEnv, { now: T0, embed: embedder.embed });
    await env.DB.prepare("UPDATE stories SET user_state = 'saved', user_state_at = ? WHERE alive = 1").bind(T0).run();
    const before = await stories();
    const beforeMembers = await membersOf(before[0]!.id as number);
    await seedClaims(env.DB, [{ tag: "S1", publishedAt: T0 + 1 }, { tag: "S2", publishedAt: T0 + 2 }, { tag: "S2", publishedAt: T0 + 3 }]);
    const sentBefore = llm.sent.length;

    // Interpose on a real D1 batch to put the takeover after the TypeScript
    // ownership check. All publication statements still execute against D1.
    let publishReady = false;
    const batch = env.DB.batch.bind(env.DB);
    const intercepted = vi.spyOn(env.DB, "batch").mockImplementation(async (statements) => {
      if (publishReady) {
        publishReady = false;
        await env.DB.prepare("UPDATE job_leases SET holder = 'successor' WHERE name = 'cluster'").run();
      }
      return batch(statements);
    });
    try {
      await expect(runClusterJob(testEnv, {
        now: T0 + HOUR, embed: embedder.embed,
        onStage: (stage) => { if (stage === "publish") publishReady = true; },
      })).rejects.toThrow(/lease lost during publish/);
    } finally {
      intercepted.mockRestore();
    }
    expect(await stories()).toEqual(before);
    expect(await membersOf(before[0]!.id as number)).toEqual(beforeMembers);
    expect(llm.sent).toHaveLength(sentBefore);
    expect(await env.DB.prepare("SELECT holder FROM job_leases WHERE name = 'cluster'").first()).toEqual({ holder: "successor" });
    expect(await env.DB.prepare("SELECT status FROM cluster_runs ORDER BY id DESC LIMIT 1").first()).toEqual({ status: "failed" });
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
