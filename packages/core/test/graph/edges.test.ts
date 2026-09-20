import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { cosine, cosineNeighbours, DEFAULT_PARAMS, entityStats, weightedEdges, type ClaimNode, type VectorMatrix } from "../../src/index";

const DIMS = 8;

function matrix(vectors: number[][], ids = vectors.map((_, index) => index + 1)): VectorMatrix {
  return { ids, dims: vectors[0]?.length ?? DIMS, data: Float32Array.from(vectors.flat()) };
}

const vectorArb = fc.array(fc.float({ min: -1, max: 1, noNaN: true }), { minLength: DIMS, maxLength: DIMS });

describe("cosine", () => {
  it("is symmetric, bounded and zero for a zero vector", () => {
    fc.assert(
      fc.property(vectorArb, vectorArb, (a, b) => {
        const x = Float32Array.from(a);
        const y = Float32Array.from(b);
        const value = cosine(x, y);
        expect(value).toBeCloseTo(cosine(y, x), 6);
        expect(value).toBeGreaterThanOrEqual(-1);
        expect(value).toBeLessThanOrEqual(1);
      }),
    );
    expect(cosine(new Float32Array(DIMS), Float32Array.from([1, 0, 0, 0, 0, 0, 0, 0]))).toBe(0);
  });
});

describe("cosineNeighbours", () => {
  it("never exceeds the neighbour cap, respects the floor, and never links claims of one item", () => {
    fc.assert(
      fc.property(fc.array(vectorArb, { minLength: 2, maxLength: 25 }), fc.integer({ min: 1, max: 5 }), (vectors, cap) => {
        const window = matrix(vectors);
        const itemOf = new Map(window.ids.map((id) => [id, Math.ceil(id / 2)]));
        const edges = cosineNeighbours(window.ids, window, itemOf, { cosineFloor: 0.3, maxNeighboursPerClaim: cap });
        const degree = new Map<number, number>();
        for (const edge of edges) {
          expect(edge.claimA).toBeLessThan(edge.claimB);
          expect(edge.cosine).toBeGreaterThanOrEqual(0.3);
          expect(itemOf.get(edge.claimA)).not.toBe(itemOf.get(edge.claimB));
          degree.set(edge.claimA, (degree.get(edge.claimA) ?? 0) + 1);
          degree.set(edge.claimB, (degree.get(edge.claimB) ?? 0) + 1);
        }
        // Each claim contributes at most `cap` edges of its own, so the total is bounded.
        expect(edges.length).toBeLessThanOrEqual(window.ids.length * cap);
      }),
      { numRuns: 60 },
    );
  });

  it("bounds a burst of 300 near-identical claims to 300 x 30 edges", () => {
    const base = Array.from({ length: 32 }, (_, d) => Math.sin(d + 1));
    const vectors = Array.from({ length: 300 }, (_, i) => base.map((value, d) => value + ((i * 31 + d * 17) % 13) * 1e-4));
    const window = matrix(vectors);
    const itemOf = new Map(window.ids.map((id) => [id, id]));
    const edges = cosineNeighbours(window.ids, window, itemOf, DEFAULT_PARAMS);
    expect(edges.length).toBeLessThanOrEqual(300 * 30);
    expect(edges.length).toBeGreaterThan(300 * 15);
  });

  it("does not depend on the order of its input", () => {
    const vectors = Array.from({ length: 12 }, (_, i) => Array.from({ length: DIMS }, (_, d) => Math.cos(i * 0.3 + d)));
    const window = matrix(vectors);
    const itemOf = new Map(window.ids.map((id) => [id, id]));
    const forward = cosineNeighbours(window.ids, window, itemOf, { cosineFloor: 0.2, maxNeighboursPerClaim: 3 });
    const shuffledIds = [...window.ids].reverse();
    const shuffled: VectorMatrix = { ids: shuffledIds, dims: DIMS, data: Float32Array.from(shuffledIds.flatMap((id) => vectors[id - 1]!)) };
    expect(cosineNeighbours(shuffledIds, shuffled, itemOf, { cosineFloor: 0.2, maxNeighboursPerClaim: 3 })).toEqual(forward);
  });

  it("only computes neighbours for the claims asked for", () => {
    const window = matrix([[1, 0], [1, 0.01], [1, 0.02]]);
    const edges = cosineNeighbours([3], window, new Map(), { cosineFloor: 0.5, maxNeighboursPerClaim: 30 });
    expect(edges.map((edge) => [edge.claimA, edge.claimB])).toEqual([[1, 3], [2, 3]]);
  });
});

describe("entityStats", () => {
  it("gives rare entities a higher IDF and flags hubs only in a big enough window", () => {
    const claims = new Map<number, number[]>();
    for (let claim = 1; claim <= 40; claim++) claims.set(claim, claim <= 20 ? [1, 100 + claim] : [1]);
    const { idf, hubs } = entityStats(claims, { hubEntityShare: 0.15 });
    expect(idf.get(101)!).toBeGreaterThan(idf.get(1)!);
    expect(idf.get(101)!).toBeLessThanOrEqual(1);
    expect([...hubs]).toEqual([1]);
    expect(entityStats(new Map([[1, [1]], [2, [1]]]), { hubEntityShare: 0.15 }).hubs.size).toBe(0);
  });
});

describe("weightedEdges", () => {
  const DAY = 86_400;
  const node = (id: number, publishedAt = 0, itemId = id): ClaimNode => ({ id, itemId, publishedAt });

  it("produces symmetric-keyed weights in [0, 1] and nothing outside the window", () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ day: fc.integer({ min: 0, max: 20 }), entities: fc.array(fc.integer({ min: 1, max: 6 }), { maxLength: 3 }) }), { minLength: 2, maxLength: 15 }),
        fc.array(fc.tuple(fc.integer({ min: 1, max: 15 }), fc.integer({ min: 1, max: 15 }), fc.float({ min: Math.fround(0.55), max: 1, noNaN: true })), { maxLength: 20 }),
        (specs, rawCosine) => {
          const claims = specs.map((spec, index) => node(index + 1, spec.day * DAY));
          const entities = new Map(specs.map((spec, index) => [index + 1, spec.entities]));
          const cosineEdges = rawCosine.filter(([a, b]) => a !== b && a <= specs.length && b <= specs.length).map(([a, b, value]) => ({ claimA: Math.min(a, b), claimB: Math.max(a, b), cosine: value }));
          const edges = weightedEdges(claims, cosineEdges, entities, new Set(), DEFAULT_PARAMS);
          const seen = new Set<string>();
          for (const edge of edges) {
            expect(edge.claimA).toBeLessThan(edge.claimB);
            expect(edge.weight).toBeGreaterThanOrEqual(DEFAULT_PARAMS.minEdgeWeight);
            expect(edge.weight).toBeLessThanOrEqual(1);
            expect(Math.abs(claims[edge.claimA - 1]!.publishedAt - claims[edge.claimB - 1]!.publishedAt)).toBeLessThanOrEqual(DEFAULT_PARAMS.windowDays * DAY);
            expect(seen.has(`${edge.claimA}:${edge.claimB}`)).toBe(false);
            seen.add(`${edge.claimA}:${edge.claimB}`);
          }
        },
      ),
      { numRuns: 80 },
    );
  });

  it("recomputes the entity part from the current resolution, so a merge takes effect on the next run", () => {
    const claims = [node(1), node(2)];
    const cosineEdges = [{ claimA: 1, claimB: 2, cosine: 0.6 }];
    // While the mention is a separate provisional entity the pair is too weak...
    expect(weightedEdges(claims, cosineEdges, new Map([[1, [10]], [2, [99]]]), new Set(), DEFAULT_PARAMS)).toEqual([]);
    // ...and once adjudication says "same entity", the very same stored cosine edge now clears the bar.
    const merged = weightedEdges(claims, cosineEdges, new Map([[1, [10]], [2, [10]]]), new Set(), DEFAULT_PARAMS);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.weight).toBeCloseTo(0.6 * 0.6 + 0.4 * 1, 6);
  });

  it("ignores stop entities and hub entities when pairing and weighting", () => {
    const claims = Array.from({ length: 30 }, (_, index) => node(index + 1));
    const entities = new Map(claims.map((claim) => [claim.id, [1, ...(claim.id <= 2 ? [50] : [])]]));
    const cosineEdges = [{ claimA: 1, claimB: 2, cosine: 0.6 }, { claimA: 3, claimB: 4, cosine: 0.6 }];
    const edges = weightedEdges(claims, cosineEdges, entities, new Set(), DEFAULT_PARAMS);
    // Entity 1 is in every claim: a hub. Only the pair sharing the rare entity 50 survives.
    expect(edges.map((edge) => [edge.claimA, edge.claimB])).toEqual([[1, 2]]);
    expect(weightedEdges(claims, cosineEdges, entities, new Set([50]), DEFAULT_PARAMS)).toEqual([]);
  });

  it("never links two claims of the same item", () => {
    const claims = [node(1, 0, 5), node(2, 0, 5)];
    expect(weightedEdges(claims, [{ claimA: 1, claimB: 2, cosine: 0.99 }], new Map([[1, [7]], [2, [7]]]), new Set(), DEFAULT_PARAMS)).toEqual([]);
  });
});
