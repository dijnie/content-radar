import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { mulberry32 } from "./graph-fixtures";

const VECTORS = 3500;
const DIMENSIONS = 1024;
const BYTES_PER_VECTOR = DIMENSIONS * Float32Array.BYTES_PER_ELEMENT;
const INSERT_BATCH = 50;

function vectorFor(id: number): Float32Array {
  const random = mulberry32(id + 1);
  const vector = new Float32Array(DIMENSIONS);
  for (let i = 0; i < DIMENSIONS; i++) vector[i] = random() * 2 - 1;
  return vector;
}

/** D1 hands BLOB columns back as a plain number array, one element per byte. */
function decodeInto(target: Float32Array, row: number, blob: unknown): void {
  const bytes = blob instanceof ArrayBuffer ? new Uint8Array(blob) : Uint8Array.from(blob as number[]);
  target.set(new Float32Array(bytes.buffer, bytes.byteOffset, DIMENSIONS), row * DIMENSIONS);
}

async function loadAll(chunkSize: number): Promise<{ merged: Float32Array; ms: number; blobKind: string }> {
  const merged = new Float32Array(VECTORS * DIMENSIONS);
  const started = Date.now();
  let blobKind = "none";
  for (let offset = 0; offset < VECTORS; offset += chunkSize) {
    // The row array goes out of scope at the end of each iteration, so only one
    // chunk of the inflated representation is alive at a time.
    const { results } = await env.DB.prepare("SELECT id, vector FROM spike_vectors WHERE id >= ? AND id < ? ORDER BY id")
      .bind(offset, offset + chunkSize)
      .all<{ id: number; vector: unknown }>();
    for (const row of results) {
      if (blobKind === "none") blobKind = row.vector instanceof ArrayBuffer ? "ArrayBuffer" : Array.isArray(row.vector) ? "number[]" : typeof row.vector;
      decodeInto(merged, row.id, row.vector);
    }
  }
  return { merged, ms: Date.now() - started, blobKind };
}

beforeAll(async () => {
  await env.DB.exec("CREATE TABLE spike_vectors (id INTEGER PRIMARY KEY, vector BLOB NOT NULL)");
  const insert = env.DB.prepare("INSERT INTO spike_vectors (id, vector) VALUES (?, ?)");
  for (let start = 0; start < VECTORS; start += INSERT_BATCH) {
    const batch = [];
    for (let id = start; id < Math.min(start + INSERT_BATCH, VECTORS); id++) {
      batch.push(insert.bind(id, vectorFor(id).buffer));
    }
    await env.DB.batch(batch);
  }
}, 120_000);

describe("D1 BLOB embeddings", () => {
  it("stores every vector at its packed size", async () => {
    const row = await env.DB.prepare("SELECT COUNT(*) AS n, SUM(LENGTH(vector)) AS bytes FROM spike_vectors").first<{ n: number; bytes: number }>();
    expect(row).toEqual({ n: VECTORS, bytes: VECTORS * BYTES_PER_VECTOR });
  });

  it("round-trips all vectors through chunked loads into one merged Float32Array", async () => {
    const report = [];
    for (const chunkSize of [100, 250, 500, 1000, VECTORS]) {
      const { merged, ms, blobKind } = await loadAll(chunkSize);
      for (const id of [0, 1, 1749, VECTORS - 1]) {
        expect(merged.subarray(id * DIMENSIONS, (id + 1) * DIMENSIONS)).toEqual(vectorFor(id));
      }
      report.push({ chunkSize, ms, blobKind, packedChunkMB: +((chunkSize * BYTES_PER_VECTOR) / 2 ** 20).toFixed(1) });
    }
    console.log("d1 blob load:", JSON.stringify(report));
  }, 120_000);
});
