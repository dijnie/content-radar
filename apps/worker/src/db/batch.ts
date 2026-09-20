// D1 caps a statement at 100 bound parameters and 100 KB, so bulk writes are
// sent as many small statements grouped into batches. Each batch is one
// implicit transaction.
export const D1_MAX_BOUND_PARAMETERS = 100;
export const DEFAULT_BATCH_SIZE = 50;

export async function chunkedBatch(
  db: D1Database,
  statements: D1PreparedStatement[],
  size: number = DEFAULT_BATCH_SIZE,
): Promise<D1Result[]> {
  if (!Number.isInteger(size) || size < 1) throw new RangeError("batch size must be a positive integer");
  const results: D1Result[] = [];
  for (let start = 0; start < statements.length; start += size) {
    results.push(...(await db.batch(statements.slice(start, start + size))));
  }
  return results;
}

/**
 * Splits `values` so that `fixedParams + chunk.length * paramsPerValue` never
 * exceeds the bound-parameter cap, e.g. for `WHERE id IN (?, ?, ...)`.
 */
export function chunkForParams<T>(values: readonly T[], paramsPerValue = 1, fixedParams = 0): T[][] {
  const perChunk = Math.floor((D1_MAX_BOUND_PARAMETERS - fixedParams) / paramsPerValue);
  if (perChunk < 1) throw new RangeError("a single value exceeds the D1 bound-parameter cap");
  const chunks: T[][] = [];
  for (let start = 0; start < values.length; start += perChunk) chunks.push(values.slice(start, start + perChunk));
  return chunks;
}

export function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
