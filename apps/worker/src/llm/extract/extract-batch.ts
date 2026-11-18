import { normalizeEntity } from "@radar/core";
import { insertClaim, insertMentions, type ClaimInput, type MentionInput } from "../../db/claims-repo";
import { chunkedBatch } from "../../db/batch";
import { type ItemRow } from "../../db/items-repo";
import { finishLlmCall, type LlmKind } from "../../db/llm-repo";
import { TEXT_EXCERPT_MAX } from "../../sources/source-adapter";
import { sha256Hex } from "../../util/hash";
import { budgetedCall, type LlmDeps, type LlmEnv } from "../budgeted-call";
import { EXTRACT_PROMPT_VERSION, extractSystemPrompt, extractUserPrompt, type PromptItem } from "./extract-prompt";
import { EXTRACT_JSON_SCHEMA, extractResponseSchema, parseClaim, QUOTE_MAX_LENGTH } from "./extract-schema";
import { normalizeForMatch, quoteFoundIn } from "./quote-match";
import { editorialSchema, type Editorial } from "./editorial-schema";

export const ITEM_TEXT_MAX = 6000;
export const BATCH_TEXT_MAX = 40_000;

export type { LlmDeps, LlmEnv } from "../budgeted-call";

export type BatchOutcome =
  /** Results of these items are committed. */
  | { status: "done"; itemIds: number[] }
  /** Short wait: a per-minute limit or a transient failure. */
  | { status: "retry"; delaySeconds: number }
  /** Budget or availability requires a longer wait: items stay queued for the next backlog drain. */
  | { status: "park" };

interface Prepared {
  item: ItemRow;
  text: string;
}

/** The text handed to LLM. The very same string is what quotes are verified against. */
async function promptText(env: LlmEnv, item: ItemRow): Promise<string> {
  let text = item.text_excerpt;
  if (text.length >= TEXT_EXCERPT_MAX && item.raw_r2_key) {
    const stored = await env.RAW.get(item.raw_r2_key);
    const payload = stored ? ((await stored.json()) as { text?: string }) : null;
    if (payload?.text) text = payload.text;
  }
  return text.slice(0, ITEM_TEXT_MAX);
}

interface Accepted {
  claim: Omit<ClaimInput, "llmCallId">;
  mentions: MentionInput[];
}

async function validateItem(prepared: Prepared, rawClaims: unknown[], topics: string[], model: string, now: number, rejected: Record<string, number>): Promise<Accepted[]> {
  const accepted = new Map<string, Accepted>();
  const reject = (reason: string) => void (rejected[reason] = (rejected[reason] ?? 0) + 1);
  for (const raw of rawClaims) {
    const claim = parseClaim(raw);
    if (!claim) reject("schema");
    else if (claim.quote.length > QUOTE_MAX_LENGTH) reject("quote_too_long");
    else if (!quoteFoundIn(claim.quote, prepared.text)) reject("quote_not_found");
    else {
      const contentHash = await sha256Hex(normalizeForMatch(claim.quote));
      if (accepted.has(contentHash)) reject("duplicate");
      else {
        const mentions = new Map<string, MentionInput>();
        for (const entity of claim.entities) {
          const normalized = normalizeEntity(entity.surface);
          if (normalized) mentions.set(normalized, { surface: entity.surface, normalized, surfaceType: entity.type });
        }
        accepted.set(contentHash, {
          claim: {
            itemId: prepared.item.id, authorId: prepared.item.author_id, kind: claim.kind, textVi: claim.text_vi, textEn: claim.text_en,
            quote: claim.quote, hasNumbers: claim.has_numbers, firstHand: claim.first_hand, topics, publishedAt: prepared.item.published_at,
            contentHash, model, promptVersion: EXTRACT_PROMPT_VERSION, createdAt: now,
          },
          mentions: [...mentions.values()],
        });
      }
    }
  }
  return [...accepted.values()];
}

/**
 * Extracts claims for a batch of queued items through the single LLM door.
 * Budget is reserved before every call and committed or released afterwards;
 * each item's result is written in its own D1 batch so one bad item cannot
 * take the others down.
 */
export async function extractBatch(env: LlmEnv, items: ItemRow[], kind: Extract<LlmKind, "extract" | "extract_backfill">, deps: LlmDeps = {}, attempt = 0): Promise<BatchOutcome> {
  const now = deps.now ?? Math.floor(Date.now() / 1000);
  if (items.length === 0) return { status: "done", itemIds: [] };
  const prepared: Prepared[] = [];
  let total = 0;
  for (const item of items) {
    const text = await promptText(env, item);
    if (prepared.length > 0 && total + text.length > BATCH_TEXT_MAX) break;
    prepared.push({ item, text });
    total += text.length;
  }

  const { results: topics } = await env.DB.prepare("SELECT slug, name FROM topics WHERE enabled = 1").all<{ slug: string; name: string }>();
  const topicSlugs = new Set(topics.map((topic) => topic.slug));
  const authors = new Map<number, string>();
  const promptItems: PromptItem[] = [];
  for (const { item, text } of prepared) {
    if (item.author_id !== null && !authors.has(item.author_id)) {
      const row = await env.DB.prepare("SELECT canonical_name FROM authors WHERE id = ?").bind(item.author_id).first<{ canonical_name: string }>();
      authors.set(item.author_id, row?.canonical_name ?? "unknown");
    }
    promptItems.push({ itemId: item.id, platform: item.platform, kind: item.kind, author: item.author_id === null ? null : (authors.get(item.author_id) ?? null), text });
  }

  const itemIds = prepared.map((entry) => entry.item.id);
  const call = await budgetedCall(
    env,
    { kind, promptVersion: EXTRACT_PROMPT_VERSION, system: extractSystemPrompt(topics), user: extractUserPrompt(promptItems), schema: EXTRACT_JSON_SCHEMA, subjectIds: itemIds },
    deps,
    attempt,
  );
  // Only a call that reached LLM counts against the item; a parked or postponed batch costs it nothing.
  if (call.status === "ok" || call.status === "rejected") await chunkedBatch(env.DB, prepared.map(({ item }) =>
    env.DB.prepare(`UPDATE items SET enqueue_attempts = enqueue_attempts + (status = 'queued'), editorial_attempts = editorial_attempts + 1
      WHERE id = ? AND content_hash = ?`).bind(item.id, item.content_hash)));
  if (call.status === "rejected") return splitAndRetry(env, prepared, kind, deps, attempt);
  if (call.status !== "ok") return call;

  const parsed = extractResponseSchema.safeParse(call.data);
  if (!parsed.success) {
    await finishLlmCall(env.DB, call.logId, { ...call.log, status: "invalid_output", error: "response did not match the schema" });
    return splitAndRetry(env, prepared, kind, deps, attempt);
  }
  const byId = new Map(prepared.map((entry) => [entry.item.id, entry]));
  const rejected: Record<string, number> = {};
  const outcomes: { prepared: Prepared; relevant: boolean; returned: number; accepted: Accepted[]; editorial: Editorial | null }[] = [];
  for (const entry of parsed.data.items) {
    const target = byId.get(entry.itemId);
    // Ids are taken from our own request only; anything else in the output is ignored.
    if (!target || outcomes.some((outcome) => outcome.prepared === target)) continue;
    const claimTopics = entry.topics.filter((topic) => topicSlugs.has(topic));
    const accepted = entry.relevant ? await validateItem(target, entry.claims, claimTopics, call.model, now, rejected) : [];
    const parsedEditorial = editorialSchema.safeParse(entry.editorial);
    let editorial = entry.relevant && accepted.length && parsedEditorial.success ? parsedEditorial.data : null;
    // Field tests require a verified first-hand claim, not merely the model's category label.
    if (editorial?.category === "field_test" && !accepted.some(({ claim }) => claim.firstHand && (claim.kind === "measurement" || claim.kind === "experience"))) editorial = null;
    outcomes.push({ prepared: target, relevant: entry.relevant, returned: entry.claims.length, accepted, editorial });
  }

  const returned = outcomes.reduce((sum, outcome) => sum + outcome.returned, 0);
  const acceptedCount = outcomes.reduce((sum, outcome) => sum + outcome.accepted.length, 0);
  await finishLlmCall(env.DB, call.logId, { ...call.log, claimsReturned: returned, claimsAccepted: acceptedCount, rejectReasons: rejected });

  const done: number[] = [];
  // One db.batch per item, on purpose: insertMentions dedupes by counting the claim's mentions, which is only
  // right while its statements run in order inside one transaction. Do not route these through chunkedBatch.
  for (const outcome of outcomes) {
    const { item } = outcome.prepared;
    await env.DB.batch([
      ...outcome.accepted.flatMap(({ claim, mentions }) => [insertClaim(env.DB, { ...claim, llmCallId: call.logId }, item.content_hash), ...insertMentions(env.DB, item.id, claim.contentHash, mentions, item.content_hash)]),
      ...(outcome.editorial ? [env.DB.prepare(`INSERT INTO item_editorial (item_id, content_hash, category, pillar, summary_vi, question_vi, model, updated_at)
        SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8 FROM items WHERE id = ?1 AND content_hash = ?2
        ON CONFLICT(item_id) DO UPDATE SET content_hash = excluded.content_hash,
        category = excluded.category, pillar = excluded.pillar, summary_vi = excluded.summary_vi,
        question_vi = excluded.question_vi, model = excluded.model, updated_at = excluded.updated_at`)
        .bind(item.id, item.content_hash, outcome.editorial.category, outcome.editorial.pillar, outcome.editorial.summary_vi, outcome.editorial.question_vi, call.model, now)] : []),
      env.DB
        .prepare("UPDATE items SET status = ?, claims_returned = ?, claims_accepted = ? WHERE id = ? AND content_hash = ? AND status = 'queued'")
        .bind(outcome.relevant ? "extracted" : "irrelevant", outcome.returned, outcome.accepted.length, item.id, item.content_hash),
    ]);
    done.push(item.id);
  }
  return { status: "done", itemIds: done };
}

/** A request LLM rejects is bisected to isolate the offending item; a single item that still fails is marked `failed`. */
async function splitAndRetry(env: LlmEnv, prepared: Prepared[], kind: Extract<LlmKind, "extract" | "extract_backfill">, deps: LlmDeps, attempt: number): Promise<BatchOutcome> {
  if (prepared.length === 1) {
    const { item } = prepared[0]!;
    await env.DB.prepare("UPDATE items SET status = 'failed', filter_reason = 'llm_rejected' WHERE id = ? AND content_hash = ? AND status = 'queued'").bind(item.id, item.content_hash).run();
    return { status: "done", itemIds: [item.id] };
  }
  const middle = Math.ceil(prepared.length / 2);
  const done: number[] = [];
  for (const half of [prepared.slice(0, middle), prepared.slice(middle)]) {
    const outcome = await extractBatch(env, half.map((entry) => entry.item), kind, deps, attempt);
    if (outcome.status !== "done") return done.length > 0 ? { status: "done", itemIds: done } : outcome;
    done.push(...outcome.itemIds);
  }
  return { status: "done", itemIds: done };
}
