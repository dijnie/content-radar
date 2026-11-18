import { getAiSettings, selectedChatModel } from "../db/ai-settings";
import { aiPaused } from "./call-control";
import { listEnabledModels } from "../db/llm-repo";
import type { Env } from "../env";
import { remainingToday } from "./budget-ledger";
import { circuitOpenUntil } from "./circuit-breaker";
import { CRAWL_FINISHED_SQL, extractionWindowStart, hasRecentQueuedItems } from "./extraction-priority";
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
 * budget can serve. Recent items take priority until none remain queued; within
 * that priority, live items come before backfill, oldest first. An item is given up only after
 * 20 extraction calls really made for it, never for wake-ups that went nowhere.
 */
export async function drainBacklog(env: Pick<Env, "DB" | "LLM_QUEUE">, now: number, manual = false, itemIds?: number[], manualLimit = BATCH_SIZE): Promise<{ sent: number; failed: number; partial?: boolean }> {
  const configuredModel = selectedChatModel(await getAiSettings(env.DB));
  if (configuredModel === "" || await aiPaused(env.DB)) return { sent: 0, failed: 0 };
  const gaveUp = await env.DB
    .prepare("UPDATE items SET status = 'failed', filter_reason = 'enqueue_attempts_exceeded' WHERE status = 'queued' AND enqueue_attempts >= ?")
    .bind(MAX_ENQUEUE_ATTEMPTS)
    .run();
  const failed = gaveUp.meta.changes ?? 0;
  if ((await circuitOpenUntil(env.DB, now)) !== null) return { sent: 0, failed };

  const settings = await loadBudgetSettings(env.DB);
  const since = await extractionWindowStart(env.DB, now);
  const recentPending = !itemIds && await hasRecentQueuedItems(env.DB, since);
  const budget = { extract: 0, extract_backfill: 0 };
  for (const model of await listEnabledModels(env.DB, configuredModel)) {
    budget.extract += await remainingToday(env.DB, model, "extract", now, settings);
    budget.extract_backfill += await remainingToday(env.DB, model, "extract_backfill", now, settings);
  }

  let sent = 0;
  for (const mode of ["live", "backfill"] as const) {
    // Backfill draws on the shared extraction budget, so what live items took is no longer available to it.
    const requests = mode === "live" ? budget.extract : Math.min(budget.extract_backfill, budget.extract - Math.ceil(sent / BATCH_SIZE));
    const limit = Math.min((manual ? manualLimit : MAX_ITEMS_PER_DRAIN) - sent, requests * BATCH_SIZE);
    if (limit <= 0) continue;
    // Claim each wake-up atomically so concurrent cron ticks cannot dispatch the same slice.
    const { results } = await env.DB.prepare(`UPDATE items SET queued_at = ? WHERE id IN (
      SELECT id FROM items WHERE status = 'queued' AND ingest_mode = ? AND (? OR queued_at IS NULL OR queued_at <= ?)
      AND (? = 0 OR published_at >= ?) AND ${CRAWL_FINISHED_SQL}
      AND (? IS NULL OR id IN (SELECT value FROM json_each(?)))
      AND NOT EXISTS (SELECT 1 FROM llm_calls c, json_each(c.item_ids_json) j
        WHERE c.kind IN ('extract','extract_backfill') AND c.status IN ('running','processing') AND c.at >= ?
        AND j.value = items.id)
      ORDER BY ${manual ? "COALESCE(queued_at, 0)," : ""} published_at, id LIMIT ?) RETURNING id`)
      .bind(now, mode, Number(manual), now - RESEND_AFTER_SECONDS, recentPending ? 1 : 0, since, itemIds ? JSON.stringify(itemIds) : null, itemIds ? JSON.stringify(itemIds) : null, now - 900, limit).all<{ id: number }>();
    if (!results.length) continue;
    const messages = results.map((row) => ({ body: { kind: "extract", itemId: row.id, ...(itemIds ? { operatorRetry: true } : {}), ...(mode === "backfill" ? { backfill: true } : {}) } satisfies LlmMessage }));
    for (let start = 0; start < messages.length; start += SEND_BATCH_SIZE) {
      const chunk = messages.slice(start, start + SEND_BATCH_SIZE);
      try {
        await env.LLM_QUEUE.sendBatch(chunk);
      } catch (error) {
        // A later dispatch can pick up only the unconfirmed part of this claim.
        const remaining = results.slice(start).map(row => row.id);
        await env.DB.prepare(`UPDATE items SET queued_at = NULL WHERE status = 'queued' AND queued_at = ?
          AND id IN (SELECT value FROM json_each(?))`).bind(now, JSON.stringify(remaining)).run();
        if (manual && sent > 0) return { sent, failed, partial: true };
        throw error;
      }
      sent += chunk.length;
    }
  }
  return { sent, failed };
}
