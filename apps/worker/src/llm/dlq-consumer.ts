import { insertLlmCall } from "../db/llm-repo";
import type { Env } from "../env";
import type { LlmMessage, PollMessage } from "./messages";

/**
 * `radar-dlq` consumer. A dead-lettered extraction means the item exhausted its
 * retries: it is marked `failed` with a visible reason instead of vanishing. A
 * dead-lettered poll needs nothing, the source's next_poll_at already retries it.
 */
export async function consumeDeadLetters(batch: MessageBatch<LlmMessage | PollMessage>, env: Pick<Env, "DB">, now = Math.floor(Date.now() / 1000)): Promise<void> {
  for (const message of batch.messages) {
    const body = message.body;
    if ("kind" in body && body.kind === "extract") {
      const result = await env.DB.prepare("UPDATE items SET status = 'failed', filter_reason = 'dead_letter' WHERE id = ? AND status = 'queued'").bind(body.itemId).run();
      if ((result.meta.changes ?? 0) > 0) {
        await insertLlmCall(env.DB, { at: now, model: "none", kind: body.backfill ? "extract_backfill" : "extract", promptVersion: 0, status: "dead_letter", itemIds: [body.itemId], error: "message exhausted its retries" });
      }
    } else {
      console.log(JSON.stringify({ event: "dead_letter", body }));
    }
    message.ack();
  }
}
