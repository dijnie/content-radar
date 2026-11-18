import { getAiSettings, selectedChatModel } from "./ai-settings";

export type LlmKind = "extract" | "extract_backfill" | "synthesize" | "adjudicate";

export interface LlmModelRow {
  model: string;
  priority: number;
  rpm: number | null;
  rpd: number | null;
  tpm: number | null;
  enabled: number;
  exhausted_until: number | null;
}

export interface LlmCallInput {
  at: number;
  model: string;
  kind: LlmKind;
  promptVersion: number;
  status: string;
  httpStatus?: number | null;
  latencyMs?: number | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  itemIds?: number[];
  claimsReturned?: number | null;
  claimsAccepted?: number | null;
  rejectReasons?: Record<string, number>;
  error?: string | null;
}

/** Resolve the configured model consistently for consumers, planners and status.
 * New custom models keep the existing 5/minute, 100/day application caps.
 * Existing limits, disabled state, cooldowns and historical usage are preserved.
 */
export async function listEnabledModels(db: D1Database, configuredModel?: string | null): Promise<LlmModelRow[]> {
  const selection = configuredModel === undefined ? selectedChatModel(await getAiSettings(db)) : configuredModel;
  if (selection !== null) {
    const model = selection.trim();
    if (!model) return [];
    await db.prepare("INSERT INTO llm_models (model, priority, rpm, rpd) VALUES (?, 1, 5, 100) ON CONFLICT(model) DO NOTHING").bind(model).run();
    const row = await db.prepare("SELECT * FROM llm_models WHERE enabled = 1 AND model = ?").bind(model).first<LlmModelRow>();
    return row ? [row] : [];
  }
  const { results } = await db.prepare("SELECT * FROM llm_models WHERE enabled = 1 ORDER BY priority").all<LlmModelRow>();
  return results;
}

export async function insertLlmCall(db: D1Database, call: LlmCallInput): Promise<number> {
  const row = await db
    .prepare(
      `INSERT INTO llm_calls (at, model, kind, prompt_version, status, http_status, latency_ms, tokens_in, tokens_out,
         item_ids_json, claims_returned, claims_accepted, reject_reasons_json, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    )
    .bind(
      call.at, call.model, call.kind, call.promptVersion, call.status, call.httpStatus ?? null, call.latencyMs ?? null,
      call.tokensIn ?? null, call.tokensOut ?? null, call.itemIds ? JSON.stringify(call.itemIds) : null,
      call.claimsReturned ?? null, call.claimsAccepted ?? null,
      call.rejectReasons ? JSON.stringify(call.rejectReasons) : null, call.error ?? null,
    )
    .first<{ id: number }>();
  if (!row) throw new Error("could not record llm call");
  return row.id;
}

/** Finalize the same attempt that was visible while the provider was running. */
export async function finishLlmCall(db: D1Database, id: number, call: LlmCallInput): Promise<void> {
  await db.prepare(`UPDATE llm_calls SET status = ?, http_status = ?, latency_ms = ?, tokens_in = ?, tokens_out = ?,
    claims_returned = ?, claims_accepted = ?, reject_reasons_json = ?, error = ? WHERE id = ?`)
    .bind(call.status, call.httpStatus ?? null, call.latencyMs ?? null, call.tokensIn ?? null, call.tokensOut ?? null,
      call.claimsReturned ?? null, call.claimsAccepted ?? null, call.rejectReasons ? JSON.stringify(call.rejectReasons) : null,
      call.error ?? null, id).run();
}
