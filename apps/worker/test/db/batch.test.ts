import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { chunkedBatch, chunkForParams, D1_MAX_BOUND_PARAMETERS, placeholders } from "../../src/db/batch";

describe("chunkForParams", () => {
  it("keeps every chunk within the bound-parameter cap", () => {
    const chunks = chunkForParams(Array.from({ length: 250 }, (_, i) => i));
    expect(chunks.map((chunk) => chunk.length)).toEqual([100, 100, 50]);
  });

  it("accounts for parameters per value and fixed parameters", () => {
    const chunks = chunkForParams(Array.from({ length: 40 }, (_, i) => i), 3, 10);
    expect(chunks.map((chunk) => chunk.length)).toEqual([30, 10]);
    for (const chunk of chunks) expect(10 + chunk.length * 3).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMETERS);
  });

  it("rejects a value that can never fit", () => {
    expect(() => chunkForParams([1], 101)).toThrow(RangeError);
  });
});

describe("chunkedBatch", () => {
  it("writes every statement across several batches", async () => {
    const insert = env.DB.prepare("INSERT INTO settings (key, value_json) VALUES (?, ?)");
    const statements = Array.from({ length: 130 }, (_, i) => insert.bind(`batch-key-${i}`, String(i)));
    const results = await chunkedBatch(env.DB, statements, 50);
    expect(results).toHaveLength(130);
    const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM settings WHERE key LIKE 'batch-key-%'").first<{ n: number }>();
    expect(row?.n).toBe(130);
  });

  it("confirms the cap is real: more than 100 bound parameters in one statement fails", async () => {
    const ids = Array.from({ length: 101 }, (_, i) => i);
    await expect(env.DB.prepare(`SELECT ${placeholders(101)}`).bind(...ids).all()).rejects.toThrow();
    for (const chunk of chunkForParams(ids)) {
      await expect(env.DB.prepare(`SELECT ${placeholders(chunk.length)}`).bind(...chunk).all()).resolves.toBeDefined();
    }
  });

  it("rejects a non-positive batch size", async () => {
    await expect(chunkedBatch(env.DB, [], 0)).rejects.toThrow(RangeError);
  });
});
