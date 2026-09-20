import type { VectorMatrix } from "@radar/core";
import { chunkedBatch } from "../db/batch";

export const EMBEDDING_MODEL = "@cf/baai/bge-m3";
export const EMBEDDING_DIMS = 1024;
/** Measured in the phase 1 spike: D1 returns BLOBs as number arrays, so rows are loaded 500 at a time. */
const LOAD_CHUNK = 500;

type VectorTable = "claim_embeddings" | "entity_embeddings";
const KEY_COLUMN: Record<VectorTable, string> = { claim_embeddings: "claim_id", entity_embeddings: "entity_id" };

export async function putVectors(db: D1Database, table: VectorTable, rows: readonly { id: number; vector: Float32Array }[], now: number): Promise<void> {
  const statement = db.prepare(
    `INSERT INTO ${table} (${KEY_COLUMN[table]}, model, dims, vector, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(${KEY_COLUMN[table]}) DO UPDATE SET model = excluded.model, dims = excluded.dims, vector = excluded.vector`,
  );
  await chunkedBatch(
    db,
    rows.map(({ id, vector }) => statement.bind(id, EMBEDDING_MODEL, vector.length, vector.buffer.slice(vector.byteOffset, vector.byteOffset + vector.byteLength), now)),
    20,
  );
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
export function loadClaimVectors(db: D1Database, since: number): Promise<VectorMatrix> {
  const filter = "FROM claim_embeddings e JOIN claims c ON c.id = e.claim_id WHERE c.published_at >= ? AND e.dims = ?";
  return loadMatrix(db, `SELECT COUNT(*) AS n ${filter}`, `SELECT e.claim_id AS id, e.vector ${filter} AND e.claim_id > ? ORDER BY e.claim_id LIMIT ?`, [since, EMBEDDING_DIMS]);
}

export function loadEntityVectors(db: D1Database): Promise<VectorMatrix> {
  const filter = "FROM entity_embeddings e WHERE e.dims = ?";
  return loadMatrix(db, `SELECT COUNT(*) AS n ${filter}`, `SELECT e.entity_id AS id, e.vector ${filter} AND e.entity_id > ? ORDER BY e.entity_id LIMIT ?`, [EMBEDDING_DIMS]);
}
