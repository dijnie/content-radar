import { getItemsByIds, type ItemRow } from "../db/items-repo";
import { adjudicateEntities } from "./adjudicate/adjudicate-entities";
import { extractBatch, type LlmDeps, type LlmEnv } from "./extract/extract-batch";
import type { LlmMessage } from "./messages";
import { synthesizeStory } from "./synthesize/synthesize-story";

type ExtractMessage = Message<LlmMessage> & { body: Extract<LlmMessage, { kind: "extract" }> };

/**
 * `radar-llm` consumer and the only caller of the Gemini client. Every message
 * is acknowledged on its own once its item's result is committed. A message
 * whose item is no longer `queued` is acknowledged without a call, which makes
 * redelivery and replayed batches harmless.
 */
export async function consumeLlmBatch(batch: MessageBatch<LlmMessage>, env: LlmEnv, deps: LlmDeps = {}): Promise<void> {
  const extract: ExtractMessage[] = [];
  for (const message of batch.messages) {
    const body = message.body;
    if (body.kind === "extract") {
      extract.push(message as ExtractMessage);
      continue;
    }
    const attempt = Math.max(0, message.attempts - 1);
    const outcome = body.kind === "synthesize" ? await synthesizeStory(env, body.storyId, deps, attempt) : await adjudicateEntities(env, body.adjudicationIds, deps, attempt);
    if (outcome.status === "retry") {
      message.retry({ delaySeconds: outcome.delaySeconds });
      continue;
    }
    // An attempt that never reached Gemini must not count against the story's three tries.
    if (body.kind === "synthesize" && outcome.status === "park") {
      await env.DB.prepare("UPDATE stories SET synthesis_attempts = MAX(0, synthesis_attempts - 1) WHERE id = ?").bind(body.storyId).run();
    }
    message.ack();
  }
  if (extract.length === 0) return;

  const items = new Map((await getItemsByIds(env.DB, extract.map((message) => message.body.itemId))).map((item) => [item.id, item]));
  const groups: Record<"extract" | "extract_backfill", { messages: ExtractMessage[]; items: ItemRow[] }> = {
    extract: { messages: [], items: [] },
    extract_backfill: { messages: [], items: [] },
  };
  const seen = new Set<number>();
  for (const message of extract) {
    const item = items.get(message.body.itemId);
    if (!item || item.status !== "queued" || seen.has(item.id)) {
      message.ack();
      continue;
    }
    seen.add(item.id);
    // The item's own ingest mode decides the budget share, not a flag that could be forged or lost.
    const group = groups[item.ingest_mode === "backfill" ? "extract_backfill" : "extract"];
    group.messages.push(message);
    group.items.push(item);
  }

  for (const kind of ["extract", "extract_backfill"] as const) {
    const group = groups[kind];
    if (group.items.length === 0) continue;
    const attempt = Math.max(0, ...group.messages.map((message) => message.attempts - 1));
    const outcome = await extractBatch(env, group.items, kind, deps, attempt);
    for (const message of group.messages) {
      if (outcome.status === "retry") message.retry({ delaySeconds: outcome.delaySeconds });
      // `park`, and items left out of a `done` batch, stay `queued` in D1; the backlog drain wakes them again.
      else message.ack();
    }
  }
}
