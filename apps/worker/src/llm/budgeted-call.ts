import { insertLlmCall, type LlmCallInput, type LlmKind } from "../db/llm-repo";
import type { Env } from "../env";
import { commit, markExhausted, release } from "./budget-ledger";
import { circuitOpenUntil, recordFailure, recordSuccess } from "./circuit-breaker";
import { generateJson } from "./gemini-client";
import { loadBudgetSettings, reserveOnChain } from "./model-chain";

export type LlmEnv = Pick<Env, "DB" | "RAW" | "LLM_QUEUE" | "GEMINI_API_KEY" | "GEMINI_BASE_URL">;

export interface LlmDeps {
  now?: number;
  fetcher?: typeof fetch;
}

export interface BudgetedRequest {
  kind: LlmKind;
  promptVersion: number;
  system: string;
  user: string;
  schema: Record<string, unknown>;
  /** Ids recorded in `llm_calls.item_ids_json` for tracing. */
  subjectIds: number[];
}

export type BudgetedResult =
  | { status: "ok"; data: unknown; model: string; log: LlmCallInput }
  /** Short wait: a per-minute limit or a transient failure. */
  | { status: "retry"; delaySeconds: number }
  /** No budget until the next reset, or the circuit is open. */
  | { status: "park" }
  /** Gemini rejected the request itself; retrying it unchanged is pointless. */
  | { status: "rejected" };

/**
 * The pipeline's single door to Gemini (the manual diagnostic probe is the only thing outside it). Reserves budget, calls, then commits when the call
 * counted against Google's quota and releases when it did not. A 429 parks the
 * model and moves down the chain. The successful call is logged by the caller,
 * which knows how many results it accepted; every failure is logged here.
 */
export async function budgetedCall(env: LlmEnv, request: BudgetedRequest, deps: LlmDeps = {}, attempt = 0): Promise<BudgetedResult> {
  const now = deps.now ?? Math.floor(Date.now() / 1000);
  if ((await circuitOpenUntil(env.DB, now)) !== null) return { status: "park" };
  const settings = await loadBudgetSettings(env.DB);
  const tried = new Set<string>();

  for (;;) {
    const chain = await reserveOnChain(env.DB, request.kind, now, settings, tried);
    if (!chain.ok) return chain.reason === "rpm_exhausted" ? { status: "retry", delaySeconds: 60 } : { status: "park" };
    const { model, reservation } = chain;

    const result = await generateJson({
      apiKey: env.GEMINI_API_KEY, model: model.model, system: request.system, user: request.user, schema: request.schema,
      ...(env.GEMINI_BASE_URL ? { baseUrl: env.GEMINI_BASE_URL } : {}), ...(deps.fetcher ? { fetcher: deps.fetcher } : {}),
    });
    const log: LlmCallInput = { at: now, model: model.model, kind: request.kind, promptVersion: request.promptVersion, status: "ok", httpStatus: result.httpStatus, latencyMs: result.latencyMs, itemIds: request.subjectIds };

    if (result.ok) {
      await commit(env.DB, reservation, result.tokensIn, result.tokensOut);
      await recordSuccess(env.DB);
      return { status: "ok", data: result.data, model: model.model, log: { ...log, tokensIn: result.tokensIn, tokensOut: result.tokensOut } };
    }

    await (result.reached ? commit(env.DB, reservation) : release(env.DB, reservation));
    await insertLlmCall(env.DB, { ...log, status: result.kind, error: result.message });
    if (result.kind === "rate_limited") {
      await markExhausted(env.DB, model, now);
      tried.add(model.model);
      continue;
    }
    if (result.kind === "invalid_request") return { status: "rejected" };
    await recordFailure(env.DB, result.kind, now);
    return { status: "retry", delaySeconds: Math.min(300, 30 * 2 ** attempt) };
  }
}
