export const CLUSTER_LEASE = "cluster";
export const LEASE_SECONDS = 75 * 60;

/**
 * Atomic lease: one statement either takes a free or expired lease or changes
 * nothing, so two overlapping cron invocations cannot both win.
 */
export async function acquireLease(db: D1Database, name: string, holder: string, now: number, seconds = LEASE_SECONDS): Promise<boolean> {
  const row = await db
    .prepare(
      `INSERT INTO job_leases (name, holder, expires_at) VALUES (?1, ?2, ?3)
       ON CONFLICT(name) DO UPDATE SET holder = ?2, expires_at = ?3 WHERE expires_at < ?4
       RETURNING holder`,
    )
    .bind(name, holder, now + seconds, now)
    .first<{ holder: string }>();
  return row?.holder === holder;
}

/** Extends the lease after a step. False means the lease was lost and the run must stop writing. */
export async function renewLease(db: D1Database, name: string, holder: string, now: number, seconds = LEASE_SECONDS): Promise<boolean> {
  const result = await db.prepare("UPDATE job_leases SET expires_at = ? WHERE name = ? AND holder = ?").bind(now + seconds, name, holder).run();
  return (result.meta.changes ?? 0) > 0;
}

export function releaseLeaseStatement(db: D1Database, name: string, holder: string): D1PreparedStatement {
  return db.prepare("DELETE FROM job_leases WHERE name = ? AND holder = ?").bind(name, holder);
}
