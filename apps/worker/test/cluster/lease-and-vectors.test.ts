import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { workersAiEmbedder } from "../../src/cluster/embedding-client";
import { acquireLease, releaseLeaseStatement, renewLease } from "../../src/cluster/job-lease";
import { EMBEDDING_DIMS, loadClaimVectors, putVectors } from "../../src/cluster/vector-store";
import { insertClaim } from "../../src/db/claims-repo";
import { upsertItem } from "../../src/db/items-repo";
import { itemInput, seedSource } from "../db/seed";

const NOW = 1_790_000_000;

describe("job lease", () => {
  it("lets exactly one of two simultaneous contenders in", async () => {
    const results = await Promise.all([acquireLease(env.DB, "lease-race", "a", NOW), acquireLease(env.DB, "lease-race", "b", NOW)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await acquireLease(env.DB, "lease-race", "c", NOW + 60)).toBe(false);
  });

  it("hands an expired lease to a new holder and refuses the old holder's renewal", async () => {
    expect(await acquireLease(env.DB, "lease-expiry", "old", NOW, 100)).toBe(true);
    expect(await renewLease(env.DB, "lease-expiry", "old", NOW + 50, 100)).toBe(true);
    expect(await acquireLease(env.DB, "lease-expiry", "new", NOW + 120, 100)).toBe(false);
    expect(await acquireLease(env.DB, "lease-expiry", "new", NOW + 151, 100)).toBe(true);
    expect(await renewLease(env.DB, "lease-expiry", "old", NOW + 160, 100)).toBe(false);
  });

  it("is free again after release, but only the holder can release it", async () => {
    await acquireLease(env.DB, "lease-release", "a", NOW);
    await releaseLeaseStatement(env.DB, "lease-release", "intruder").run();
    expect(await acquireLease(env.DB, "lease-release", "b", NOW)).toBe(false);
    await releaseLeaseStatement(env.DB, "lease-release", "a").run();
    expect(await acquireLease(env.DB, "lease-release", "b", NOW)).toBe(true);
  });
});

describe("vector store", () => {
  it("round-trips more vectors than one load chunk, ordered by claim id and filtered by the window", async () => {
    const sourceId = await seedSource(env.DB, "x", "vector-src");
    const ids: number[] = [];
    for (let n = 0; n < 3; n++) {
      const { id: itemId } = await upsertItem(env.DB, itemInput({ sourceId, externalId: `vec-${n}` }));
      const publishedAt = n === 2 ? NOW - 40 * 86_400 : NOW;
      await insertClaim(env.DB, { itemId, authorId: null, kind: "report", textVi: "Một câu tiếng Việt đủ dài.", textEn: "An English sentence long enough.", quote: `quote ${n}`, hasNumbers: false, firstHand: false, topics: [], publishedAt, contentHash: `vec-hash-${n}`, model: "m", promptVersion: 1, llmCallId: null, createdAt: NOW }).run();
      ids.push((await env.DB.prepare("SELECT id FROM claims WHERE content_hash = ?").bind(`vec-hash-${n}`).first<{ id: number }>())!.id);
    }
    const vector = (seed: number) => Float32Array.from({ length: EMBEDDING_DIMS }, (_, d) => Math.fround(Math.sin(seed * 31 + d)));
    await putVectors(env.DB, "claim_embeddings", ids.map((id, n) => ({ id, vector: vector(n) })), NOW);
    await putVectors(env.DB, "claim_embeddings", [{ id: ids[0]!, vector: vector(7) }], NOW);

    const matrix = await loadClaimVectors(env.DB, NOW - 7 * 86_400);
    const mine = matrix.ids.map((id, index) => ({ id, index })).filter((entry) => ids.includes(entry.id));
    expect(mine.map((entry) => entry.id)).toEqual([ids[0], ids[1]]);
    expect(matrix.data.subarray(mine[0]!.index * EMBEDDING_DIMS, (mine[0]!.index + 1) * EMBEDDING_DIMS)).toEqual(vector(7));
    expect(matrix.data.subarray(mine[1]!.index * EMBEDDING_DIMS, (mine[1]!.index + 1) * EMBEDDING_DIMS)).toEqual(vector(1));
  });
});

describe("workersAiEmbedder", () => {
  it("batches by 50, retries a failed batch and reports token use", async () => {
    const calls: number[] = [];
    let failures = 1;
    const ai = { run: async (_model: string, input: { text: string[] }) => {
      calls.push(input.text.length);
      if (failures-- > 0) throw new Error("upstream hiccup");
      return { data: input.text.map(() => Array.from({ length: EMBEDDING_DIMS }, () => 0.5)) };
    } } as unknown as Ai;
    let tokens = 0;
    const vectors = await workersAiEmbedder(ai, (n) => void (tokens += n))(Array.from({ length: 120 }, (_, n) => `claim text number ${n}`));
    expect(vectors).toHaveLength(120);
    expect(calls).toEqual([50, 50, 50, 20]);
    expect(tokens).toBeGreaterThan(0);
  });

  it("gives up after three attempts and rejects a malformed response", async () => {
    const broken = { run: async () => ({ data: [[1, 2, 3]] }) } as unknown as Ai;
    await expect(workersAiEmbedder(broken)(["x"])).rejects.toThrow("unexpected embedding shape");
  });
});
