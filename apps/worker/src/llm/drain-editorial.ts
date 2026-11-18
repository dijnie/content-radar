import { aiPaused } from "./call-control";
import { getAiSettings, selectedChatModel } from "../db/ai-settings";
import type { Env } from "../env";
import type { LlmMessage } from "./messages";
import { CRAWL_FINISHED_SQL } from "./extraction-priority";

/** Upgrade older extracted items without resetting their story/user state or increasing the AI budget. */
export async function drainEditorial(env: Pick<Env, "DB" | "LLM_QUEUE">, now: number): Promise<number> {
  if (await aiPaused(env.DB) || selectedChatModel(await getAiSettings(env.DB)) === "") return 0;
  // Ordinary extraction owns the budget first. Metadata enrichment must not starve fresh content.
  const pending = await env.DB.prepare(`SELECT 1 FROM items WHERE status = 'queued' AND ${CRAWL_FINISHED_SQL} LIMIT 1`).first();
  if (pending) return 0;
  const rows = await env.DB.prepare(`SELECT id FROM items WHERE status = 'extracted' AND published_at >= ?
    AND editorial_attempts < 3 AND (queued_at IS NULL OR queued_at <= ?) AND ${CRAWL_FINISHED_SQL}
    AND NOT EXISTS (SELECT 1 FROM item_editorial e WHERE e.item_id = items.id AND e.content_hash = items.content_hash)
    ORDER BY published_at DESC, id DESC LIMIT 10`).bind(now - 90 * 86400, now - 1800).all<{ id: number }>();
  if (!rows.results.length) return 0;
  await env.DB.batch(rows.results.map((row) => env.DB.prepare("UPDATE items SET queued_at = ? WHERE id = ?").bind(now, row.id)));
  await env.LLM_QUEUE.sendBatch(rows.results.map((row) => ({ body: { kind: "editorial", itemId: row.id } satisfies LlmMessage })));
  return rows.results.length;
}
