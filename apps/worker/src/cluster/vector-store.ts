import type { VectorMatrix } from "@radar/core";
import { windowStart, type JobContext } from "./job-context";
import { chunkedBatch, placeholders } from "../db/batch";

export const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";
export const EMBEDDING_DIMS = 1024;
/** Measured in the phase 1 spike: D1 returns BLOBs as number arrays, so rows are loaded 500 at a time. */
const LOAD_CHUNK = 500;

type VectorTable = "claim_embeddings" | "entity_embeddings";
const KEY_COLUMN: Record<VectorTable, string> = { claim_embeddings: "claim_id", entity_embeddings: "entity_id" };

type VectorRow = { id: number; vector: Float32Array };

function vectorWrites(db: D1Database, table: VectorTable, rows: readonly VectorRow[], now: number, model: string) {
  const statement = db.prepare(
    `INSERT INTO ${table} (${KEY_COLUMN[table]}, model, dims, vector, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(${KEY_COLUMN[table]}) DO UPDATE SET model = excluded.model, dims = excluded.dims,
       vector = excluded.vector, created_at = excluded.created_at`,
  );
  return rows.map(({ id, vector }) => statement.bind(id, model, vector.length, vector.buffer.slice(vector.byteOffset, vector.byteOffset + vector.byteLength), now));
}

export async function putVectors(db: D1Database, table: VectorTable, rows: readonly VectorRow[], now: number, model: string): Promise<void> {
  await chunkedBatch(db, vectorWrites(db, table, rows, now, model), 20);
}

/** Refresh the active cache before publishing with a different embedding model. Each batch can be resumed after a failed request. */
export async function refreshEmbeddingCache(ctx: JobContext): Promise<void> {
  for (const table of ["entity_embeddings", "claim_embeddings"] as const) {
    const stale = table === "entity_embeddings"
      ? ctx.db.prepare(`SELECT e.entity_id AS id, n.canonical_name AS text FROM entity_embeddings e JOIN entities n ON n.id = e.entity_id
          WHERE e.model <> ?1 AND e.entity_id > ?2 ORDER BY e.entity_id LIMIT 50`)
      : ctx.db.prepare(`SELECT e.claim_id AS id, c.text_en AS text FROM claim_embeddings e JOIN claims c ON c.id = e.claim_id
          WHERE e.model <> ?1 AND e.claim_id > ?2 AND c.published_at >= ?3 ORDER BY e.claim_id LIMIT 50`);
    const window = table === "claim_embeddings" ? [windowStart(ctx)] : [];
    let lastId = 0;
    for (;;) {
      const { results } = await stale.bind(ctx.embeddingModel, lastId, ...window).all<{ id: number; text: string }>();
      if (!results.length) break;
      const vectors = await ctx.embed(results.map(row => row.text));
      const writes = vectorWrites(ctx.db, table, results.map((row, i) => ({ id: row.id, vector: vectors[i]! })), ctx.now, ctx.embeddingModel);
      if (table === "claim_embeddings") {
        const ids = results.map(row => row.id);
        const slots = placeholders(ids.length);
        writes.unshift(ctx.db.prepare(`DELETE FROM claim_edges WHERE claim_a IN (${slots}) OR claim_b IN (${slots})`).bind(...ids, ...ids));
      }
      await ctx.db.batch(writes);
      lastId = results[results.length - 1]!.id;
    }
  }
}

function decodeInto(target: Float32Array, rowIndex: number, dims: number, blob: unknown): void {
  const bytes = blob instanceof ArrayBuffer ? new Uint8Array(blob) : Uint8Array.from(blob as number[]);
  target.set(new Float32Array(bytes.buffer, bytes.byteOffset, dims), rowIndex * dims);
}

/**
 * Loads vectors into one packed matrix. Each chunk's row array goes out of scope
 * before the next is fetched, so only one inflated chunk is alive at a time.
 */
async function loadMatrix(db: D1Database, countSql: string, pageSql: string, binds: unknown[]): Promise<VectorMatrix> {
  const total = (await db.prepare(countSql).bind(...binds).first<{ n: number }>())?.n ?? 0;
  const ids: number[] = [];
  const data = new Float32Array(total * EMBEDDING_DIMS);
  let lastId = 0;
  while (ids.length < total) {
    const { results } = await db.prepare(pageSql).bind(...binds, lastId, LOAD_CHUNK).all<{ id: number; vector: unknown }>();
    if (results.length === 0) break;
    for (const row of results) {
      decodeInto(data, ids.length, EMBEDDING_DIMS, row.vector);
      ids.push(row.id);
      lastId = row.id;
    }
  }
  return { ids, dims: EMBEDDING_DIMS, data: ids.length === total ? data : data.subarray(0, ids.length * EMBEDDING_DIMS) };
}

/** Vectors of claims published since `since`, ordered by claim id. */
export function loadClaimVectors(db: D1Database, since: number, model: string): Promise<VectorMatrix> {
  const filter = "FROM claim_embeddings e JOIN claims c ON c.id = e.claim_id WHERE c.published_at >= ? AND e.dims = ? AND e.model = ?";
  return loadMatrix(db, `SELECT COUNT(*) AS n ${filter}`, `SELECT e.claim_id AS id, e.vector ${filter} AND e.claim_id > ? ORDER BY e.claim_id LIMIT ?`, [since, EMBEDDING_DIMS, model]);
}

export function loadEntityVectors(db: D1Database, model: string): Promise<VectorMatrix> {
  const filter = "FROM entity_embeddings e WHERE e.dims = ? AND e.model = ?";
  return loadMatrix(db, `SELECT COUNT(*) AS n ${filter}`, `SELECT e.entity_id AS id, e.vector ${filter} AND e.entity_id > ? ORDER BY e.entity_id LIMIT ?`, [EMBEDDING_DIMS, model]);
}
