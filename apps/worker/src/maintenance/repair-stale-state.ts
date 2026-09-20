/**
 * Puts work that a lost message or a dead invocation left behind back where
 * the normal jobs will find it. Every repair is safe to repeat.
 */
export async function repairStaleState(db: D1Database, now: number): Promise<{ failedRuns: number; requeuedAdjudications: number }> {
  const [runs, adjudications] = await db.batch([
    // A run still `running` with no live lease belongs to an invocation that is gone.
    db
      .prepare("UPDATE cluster_runs SET status = 'failed', error = COALESCE(error, 'lease expired'), finished_at = ?1 WHERE status = 'running' AND NOT EXISTS (SELECT 1 FROM job_leases WHERE name = 'cluster' AND expires_at >= ?1)")
      .bind(now),
    // An adjudication still queued when the daily job runs has most likely lost its
    // message. The next cluster run sends it again; a duplicate is harmless because
    // the consumer skips rows that are already decided.
    db.prepare("UPDATE entity_adjudications SET status = 'pending' WHERE status = 'queued'"),
  ]);
  return { failedRuns: runs?.meta.changes ?? 0, requeuedAdjudications: adjudications?.meta.changes ?? 0 };
}
