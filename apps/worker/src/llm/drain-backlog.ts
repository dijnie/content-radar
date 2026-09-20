import { chunkedBatch } from "../db/batch";
import { touchEnqueued } from "../db/items-repo";
import { listEnabledModels } from "../db/llm-repo";
import type { Env } from "../env";
import { remainingToday } from "./budget-ledger";
import { circuitOpenUntil } from "./circuit-breaker";
import type { LlmMessage } from "./messages";
import { loadBudgetSettings } from "./model-chain";

const BATCH_SIZE = 10;
const RESEND_AFTER_SECONDS = 30 * 60;
const MAX_ENQUEUE_ATTEMPTS = 20;
const MAX_ITEMS_PER_DRAIN = 500;
const SEND_BATCH_SIZE = 100;

/**
 * D1 is the backlog. Every 30 minutes, items still `queued` whose last wake-up
 * is older than 30 minutes are announced again, as many as today's remaining
 * budget can serve: live items first, oldest first.
 */
export async function drainBacklog(env: Pick<Env, "DB" | "LLM_QUEUE">, now: number): Promise<{ sent: number; failed: number }> {
  const gaveUp = await env.DB
    .prepare("UPDATE items SET status = 'failed', filter_reason = 'enqueue_attempts_exceeded' WHERE status = 'queued' AND enqueue_attempts >= ?")
    .bind(MAX_ENQUEUE_ATTEMPTS)
    .run();
  const failed = gaveUp.meta.changes ?? 0;
  if ((await circuitOpenUntil(env.DB, now)) !== null) return { sent: 0, failed };

  const settings = await loadBudgetSettings(env.DB);
  const budget = { extract: 0, extract_backfill: 0 };
  for (const model of await listEnabledModels(env.DB)) {
    budget.extract += await remainingToday(env.DB, model, "extract", now, settings);
    budget.extract_backfill += await remainingToday(env.DB, model, "extract_backfill", now, settings);
  }

  let sent = 0;
  for (const mode of ["live", "backfill"] as const) {
    // Backfill draws on the shared extraction budget, so what live items took is no longer available to it.
    const requests = mode === "live" ? budget.extract : Math.min(budget.extract_backfill, budget.extract - Math.ceil(sent / BATCH_SIZE));
    const limit = Math.min(MAX_ITEMS_PER_DRAIN - sent, requests * BATCH_SIZE);
    if (limit <= 0) continue;
    const { results } = await env.DB
      .prepare("SELECT id FROM items WHERE status = 'queued' AND ingest_mode = ? AND (queued_at IS NULL OR queued_at <= ?) ORDER BY published_at LIMIT ?")
      .bind(mode, now - RESEND_AFTER_SECONDS, limit)
      .all<{ id: number }>();
    if (results.length === 0) continue;

    // Ledger first: the attempt is recorded before the wake-up goes out.
    await chunkedBatch(env.DB, results.map((row) => touchEnqueued(env.DB, row.id, now)));
    const messages = results.map((row) => ({ body: { kind: "extract", itemId: row.id, ...(mode === "backfill" ? { backfill: true } : {}) } satisfies LlmMessage }));
    for (let start = 0; start < messages.length; start += SEND_BATCH_SIZE) await env.LLM_QUEUE.sendBatch(messages.slice(start, start + SEND_BATCH_SIZE));
    sent += results.length;
  }
  return { sent, failed };
}
