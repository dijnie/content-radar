/** Rows of a packed matrix: vector `i` occupies `[i * dims, (i + 1) * dims)`. */
export interface VectorMatrix {
  ids: readonly number[];
  dims: number;
  data: Float32Array;
}

export function row(matrix: VectorMatrix, index: number): Float32Array {
  return matrix.data.subarray(index * matrix.dims, (index + 1) * matrix.dims);
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return Math.max(-1, Math.min(1, dot / Math.sqrt(normA * normB)));
}

/** Unit-length copy of every row, so later cosines are plain dot products. */
export function normalizeRows(matrix: VectorMatrix): VectorMatrix {
  const data = new Float32Array(matrix.data.length);
  for (let i = 0; i < matrix.ids.length; i++) {
    const source = row(matrix, i);
    let norm = 0;
    for (const value of source) norm += value * value;
    const scale = norm === 0 ? 0 : 1 / Math.sqrt(norm);
    for (let d = 0; d < matrix.dims; d++) data[i * matrix.dims + d] = source[d]! * scale;
  }
  return { ids: matrix.ids, dims: matrix.dims, data };
}

export function centroid(vectors: readonly Float32Array[], dims: number): Float32Array {
  const mean = new Float32Array(dims);
  for (const vector of vectors) for (let d = 0; d < dims; d++) mean[d]! += vector[d]!;
  if (vectors.length > 0) for (let d = 0; d < dims; d++) mean[d]! /= vectors.length;
  return mean;
}
