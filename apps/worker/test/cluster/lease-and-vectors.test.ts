import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openAiEmbedder } from "../../src/cluster/embedding-client";
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
    await putVectors(env.DB, "claim_embeddings", ids.map((id, n) => ({ id, vector: vector(n) })), NOW, "test");
    await putVectors(env.DB, "claim_embeddings", [{ id: ids[0]!, vector: vector(7) }], NOW, "test");

    const matrix = await loadClaimVectors(env.DB, NOW - 7 * 86_400, "test");
    const mine = matrix.ids.map((id, index) => ({ id, index })).filter((entry) => ids.includes(entry.id));
    expect(mine.map((entry) => entry.id)).toEqual([ids[0], ids[1]]);
    expect(matrix.data.subarray(mine[0]!.index * EMBEDDING_DIMS, (mine[0]!.index + 1) * EMBEDDING_DIMS)).toEqual(vector(7));
    expect(matrix.data.subarray(mine[1]!.index * EMBEDDING_DIMS, (mine[1]!.index + 1) * EMBEDDING_DIMS)).toEqual(vector(1));
  });
});

describe("openAiEmbedder", () => {
  const config = { LLM_ENDPOINT: "https://provider.example/v1/chat/completions/?version=1", LLM_API_KEY: "key", EMBEDDING_MODEL: "text-embedding-3-small" };
  afterEach(() => { vi.unstubAllGlobals(); });

  it("uses the embedding route, retries a failed batch and restores input order", async () => {
    const calls: number[] = [];
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      expect(url).toBe("https://provider.example/v1/embeddings?version=1");
      expect(init).toMatchObject({ method: "POST", headers: { Authorization: "Bearer key" }, redirect: "manual" });
      const body = JSON.parse(String(init!.body));
      expect(body).toMatchObject({ model: config.EMBEDDING_MODEL, dimensions: 1024, encoding_format: "float" });
      const input = body.input as string[];
      calls.push(input.length);
      if (calls.length === 1) return new Response(null, { status: 503 });
      const data = input.map((text, index) => ({ index, embedding: Array(EMBEDDING_DIMS).fill(Number(text)) })).reverse();
      return Response.json({ data, usage: { prompt_tokens: 10 } });
    });
    vi.stubGlobal("fetch", fetcher);
    let tokens = 0;
    const input = Array.from({ length: 120 }, (_, i) => String(i));
    const vectors = await openAiEmbedder(config, n => { tokens += n; })(input);
    expect(vectors.map(v => v[0])).toEqual(input.map(Number));
    expect(calls).toEqual([50, 50, 50, 20]);
    expect(tokens).toBe(30);
  });

  it("rejects malformed dimensions and duplicate indices", async () => {
    const vector = Array(EMBEDDING_DIMS).fill(0);
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ data: [{ index: 0, embedding: [1] }] }))
      .mockResolvedValueOnce(Response.json({ data: [0, 0].map(index => ({ index, embedding: vector })) }));
    vi.stubGlobal("fetch", fetcher);
    await expect(openAiEmbedder(config)(["x"])).rejects.toThrow("1024-dimensional");
    await expect(openAiEmbedder(config)(["x", "y"])).rejects.toThrow("index");
  });

  it("does not retry invalid credentials or send a request without a key", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 401 }));
    vi.stubGlobal("fetch", fetcher);
    await expect(openAiEmbedder({ ...config, LLM_API_KEY: "" })(["x"])).rejects.toThrow("llm_api_key_missing");
    await expect(openAiEmbedder(config)(["x"])).rejects.toThrow("embedding_http_401");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
