import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { ClusterEnv } from "../../src/cluster/job-context";
import { runClusterJob } from "../../src/cluster/run-cluster-job";
import { fakeEmbedder, fakeLlmQueue, seedClaims, wipeClusterState } from "./seed-claims";

const HOUR = 3600;
const DAY = 86_400;
const T0 = Date.UTC(2026, 8, 20, 12, 5, 0) / 1000;
let testEnv: ClusterEnv;

beforeEach(async () => {
  await wipeClusterState(env.DB);
  testEnv = { DB: env.DB, LLM_QUEUE: fakeLlmQueue().queue };
});

const alive = async () => (await env.DB.prepare("SELECT id, status, independent_sources, user_state FROM stories WHERE alive = 1 ORDER BY id").all<{ id: number; status: string; independent_sources: number; user_state: string }>()).results;
const sizeOf = async (storyId: number) => (await env.DB.prepare("SELECT COUNT(*) AS n FROM story_claims WHERE story_id = ? AND active = 1").bind(storyId).first<{ n: number }>())!.n;
const eventsOf = async (runId: number) => (await env.DB.prepare("SELECT type, story_id, related_story_id FROM lineage_events WHERE run_id = ? ORDER BY id").bind(runId).all()).results;

describe("lineage end to end", () => {
  it("a story born while a run was dying is born once, by the next run, and the orphan stays invisible", async () => {
    const embedder = fakeEmbedder();
    await seedClaims(env.DB, Array.from({ length: 6 }, (_, k) => ({ tag: "S1", publishedAt: T0 - (k + 1) * HOUR })));
    await runClusterJob(testEnv, { now: T0, embed: embedder.embed });
    await seedClaims(env.DB, Array.from({ length: 6 }, (_, k) => ({ tag: "S2", publishedAt: T0 + 600 + k })));

    await expect(runClusterJob(testEnv, { now: T0 + HOUR, embed: embedder.embed, onStage: (stage) => { if (stage === "finalize") throw new Error("evicted"); } })).rejects.toThrow("evicted");
    // The dying run reserved an id for the new story, but nothing a reader can see.
    expect(await alive()).toHaveLength(1);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM stories WHERE alive = 0 AND died_at IS NULL").first()).toEqual({ n: 1 });

    const recovered = await runClusterJob(testEnv, { now: T0 + 2 * HOUR, embed: embedder.embed });
    expect(await alive()).toHaveLength(2);
    expect((await eventsOf(recovered.status === "done" ? recovered.runId : 0)).map((event) => event.type).sort()).toEqual(["birth", "continue"]);
  });

  it("when a story splits, the saved state stays with the largest child and the split is recorded", async () => {
    const embedder = fakeEmbedder();
    // One story whose claims share a tag, so they cluster together at first.
    const ids = await seedClaims(env.DB, Array.from({ length: 10 }, (_, k) => ({ tag: "S1", publishedAt: T0 - (k + 1) * HOUR })));
    await runClusterJob(testEnv, { now: T0, embed: embedder.embed });
    const [parent] = await alive();
    await env.DB.prepare("UPDATE stories SET user_state = 'saved', user_state_at = ? WHERE id = ?").bind(T0, parent!.id).run();

    // The conversation forks: four claims drift to a different subject. Re-embedding them moves them away.
    const drifting = ids.slice(0, 4);
    await env.DB.prepare(`UPDATE claims SET text_en = REPLACE(text_en, 'S1 ', 'S9 ') WHERE id IN (${drifting.join(",")})`).run();
    await env.DB.prepare(`DELETE FROM claim_embeddings WHERE claim_id IN (${drifting.join(",")})`).run();
    await env.DB.prepare(`DELETE FROM claim_edges WHERE claim_a IN (${drifting.join(",")}) OR claim_b IN (${drifting.join(",")})`).run();

    const run = await runClusterJob(testEnv, { now: T0 + HOUR, embed: embedder.embed });
    const after = await alive();
    expect(after).toHaveLength(2);
    const kept = after.find((story) => story.id === parent!.id)!;
    const child = after.find((story) => story.id !== parent!.id)!;
    expect(kept.user_state).toBe("saved");
    expect(await sizeOf(kept.id)).toBe(6);
    expect(child.user_state).toBe("inbox");
    expect(await sizeOf(child.id)).toBe(4);
    expect(await eventsOf(run.status === "done" ? run.runId : 0)).toEqual([
      { type: "split", story_id: child.id, related_story_id: parent!.id },
      { type: "split", story_id: parent!.id, related_story_id: parent!.id },
    ]);
    // The claims that left are switched off in the parent, not deleted.
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM story_claims WHERE story_id = ? AND active = 0").bind(parent!.id).first()).toEqual({ n: 4 });
  });

  it("when two stories merge, the absorbed one ends and a choice made on it moves to the heir", async () => {
    const embedder = fakeEmbedder();
    const big = await seedClaims(env.DB, Array.from({ length: 6 }, (_, k) => ({ tag: "S1", publishedAt: T0 - (k + 1) * HOUR })));
    const small = await seedClaims(env.DB, Array.from({ length: 4 }, (_, k) => ({ tag: "S2", publishedAt: T0 - (k + 1) * HOUR })));
    await runClusterJob(testEnv, { now: T0, embed: embedder.embed });
    const before = await alive();
    expect(before).toHaveLength(2);
    const storyOf = async (claimId: number) => (await env.DB.prepare("SELECT story_id FROM story_claims WHERE claim_id = ? AND active = 1").bind(claimId).first<{ story_id: number }>())!.story_id;
    const heir = await storyOf(big[0]!);
    const absorbed = await storyOf(small[0]!);
    await env.DB.prepare("UPDATE stories SET user_state = 'saved', user_state_at = ? WHERE id = ?").bind(T0, absorbed).run();

    // The two conversations converge: the smaller story's claims now read like the bigger one's.
    await env.DB.prepare(`UPDATE claims SET text_en = REPLACE(text_en, 'S2 ', 'S1 ') WHERE id IN (${small.join(",")})`).run();
    await env.DB.prepare(`DELETE FROM claim_embeddings WHERE claim_id IN (${small.join(",")})`).run();
    await env.DB.prepare(`DELETE FROM claim_edges WHERE claim_a IN (${small.join(",")}) OR claim_b IN (${small.join(",")})`).run();

    const run = await runClusterJob(testEnv, { now: T0 + HOUR, embed: embedder.embed });
    expect(await alive()).toEqual([expect.objectContaining({ id: heir, user_state: "saved" })]);
    expect(await sizeOf(heir)).toBe(10);
    expect(await env.DB.prepare("SELECT alive, died_at, (SELECT COUNT(*) FROM story_claims WHERE story_id = stories.id AND active = 1) AS active FROM stories WHERE id = ?").bind(absorbed).first()).toEqual({ alive: 0, died_at: T0 + HOUR, active: 0 });
    expect(await eventsOf(run.status === "done" ? run.runId : 0)).toEqual([{ type: "merge", story_id: heir, related_story_id: absorbed }]);
  });

  it("a READY story falls back to LEAD when its second source leaves the window", async () => {
    const embedder = fakeEmbedder();
    await seedClaims(env.DB, [
      { tag: "S1", publishedAt: T0 - 6 * DAY, authorKey: "second-voice" },
      { tag: "S1", publishedAt: T0 - HOUR, authorKey: "main-voice" },
      { tag: "S1", publishedAt: T0 - 2 * HOUR, authorKey: "main-voice" },
    ]);
    await runClusterJob(testEnv, { now: T0, embed: embedder.embed });
    const [story] = await alive();
    expect(story).toMatchObject({ status: "ready", independent_sources: 2 });

    // Two days later the older voice is outside the 7-day window.
    await runClusterJob(testEnv, { now: T0 + 2 * DAY, embed: embedder.embed });
    const [later] = await alive();
    expect(later).toMatchObject({ id: story!.id, status: "lead", independent_sources: 1 });
    expect(await sizeOf(story!.id)).toBe(2);
  });

  it("a story with no claims left in the window dies after the lookback, and the death is recorded", async () => {
    const embedder = fakeEmbedder();
    await seedClaims(env.DB, [{ tag: "S1", publishedAt: T0 - 6 * DAY }, { tag: "S1", publishedAt: T0 - 6 * DAY - 60 }]);
    await runClusterJob(testEnv, { now: T0, embed: embedder.embed });
    const [story] = await alive();

    await runClusterJob(testEnv, { now: T0 + 2 * DAY, embed: embedder.embed });
    expect(await alive()).toEqual([]);
    const row = await env.DB.prepare("SELECT alive, died_at FROM stories WHERE id = ?").bind(story!.id).first();
    expect(row).toEqual({ alive: 0, died_at: T0 + 2 * DAY });
  });
});
