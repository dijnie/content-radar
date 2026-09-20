export interface CosineEdge {
  claimA: number;
  claimB: number;
  cosine: number;
}

/** Stores the invariant cosine part of an edge with the smaller claim id first. */
export function upsertClaimEdge(db: D1Database, edge: CosineEdge, createdAt: number): D1PreparedStatement {
  const [a, b] = edge.claimA < edge.claimB ? [edge.claimA, edge.claimB] : [edge.claimB, edge.claimA];
  return db
    .prepare(
      `INSERT INTO claim_edges (claim_a, claim_b, cosine, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(claim_a, claim_b) DO UPDATE SET cosine = excluded.cosine`,
    )
    .bind(a, b, edge.cosine, createdAt);
}
