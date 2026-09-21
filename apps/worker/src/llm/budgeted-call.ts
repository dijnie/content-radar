import { insertLlmCall, type LlmCallInput, type LlmKind } from "../db/llm-repo";
import type { Env } from "../env";
import { commit, markRateLimited, release, restOverloaded } from "./budget-ledger";
import { circuitOpenUntil, pauseCircuit, recordFailure, recordSuccess } from "./circuit-breaker";
import { generateJson } from "./deepseek-client";
import { loadBudgetSettings, reserveOnChain } from "./model-chain";

export type LlmEnv = Pick<Env, "DB" | "RAW" | "LLM_QUEUE" | "DEEPSEEK_API_KEY" | "DEEPSEEK_BASE_URL" | "AI_GATEWAY_ID"> & { AI?: Pick<Ai, "run"> };

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
  /** Leave work in D1 for the next scheduler run: no budget, open circuit or prolonged unavailability. */
  | { status: "park" }
  /** DeepSeek rejected the request itself; retrying it unchanged is pointless. */
  | { status: "rejected" };

// Both queue configs allow five retries. Stop availability waits before that
// transport limit: D1 can wake the work later, whereas dead-lettering fails it.
const MAX_AVAILABILITY_RETRIES = 4;

/**
 * Reserves an application request slot before each provider attempt. HTTP responses
 * count toward this local cap; network failures before headers release the slot.
 * Actual paid usage is recorded separately in token counts returned by DeepSeek.
 */
export async function budgetedCall(env: LlmEnv, request: BudgetedRequest, deps: LlmDeps = {}, attempt = 0): Promise<BudgetedResult> {
  const now = deps.now ?? Math.floor(Date.now() / 1000);
  if ((await circuitOpenUntil(env.DB, now)) !== null) return { status: "park" };
  const settings = await loadBudgetSettings(env.DB);
  const tried = new Set<string>();
  // Set once a model answered with a server error. Such a model is skipped for this call only:
  // an overloaded model says nothing about the others, and nothing about tomorrow.
  let serverError: string | null = null;
  const retryLater: BudgetedResult = { status: "retry", delaySeconds: Math.min(300, 30 * 2 ** attempt) };
  const parkForAvailability = attempt >= MAX_AVAILABILITY_RETRIES;

  for (;;) {
    const chain = await reserveOnChain(env.DB, request.kind, now, settings, tried);
    if (!chain.ok) {
      // Only on the call that saw the errors itself. A later call that merely finds the models resting waits quietly.
      if (serverError !== null) {
        // Every model left in the chain failed the same way: now it is a pipeline problem.
        await recordFailure(env.DB, serverError, now);
        return parkForAvailability ? { status: "park" } : retryLater;
      }
      return chain.reason === "rpm_exhausted" && !parkForAvailability ? { status: "retry", delaySeconds: 60 } : { status: "park" };
    }
    const { model, reservation } = chain;

    const result = await generateJson({
      apiKey: env.DEEPSEEK_API_KEY ?? "", model: model.model, system: request.system, user: request.user, schema: request.schema,
      ...(env.AI_GATEWAY_ID !== undefined ? { gatewayId: env.AI_GATEWAY_ID, ...(env.AI ? { ai: env.AI } : {}) } : {}),
      ...(env.DEEPSEEK_BASE_URL ? { baseUrl: env.DEEPSEEK_BASE_URL } : {}), ...(deps.fetcher ? { fetcher: deps.fetcher } : {}),
    });
    const log: LlmCallInput = { at: now, model: model.model, kind: request.kind, promptVersion: request.promptVersion, status: "ok", httpStatus: result.httpStatus, latencyMs: result.latencyMs, itemIds: request.subjectIds };

    if (result.ok) {
      await commit(env.DB, reservation, result.tokensIn, result.tokensOut);
      await recordSuccess(env.DB);
      return { status: "ok", data: result.data, model: model.model, log: { ...log, tokensIn: result.tokensIn, tokensOut: result.tokensOut } };
    }

    await (result.reached ? commit(env.DB, reservation, result.tokensIn, result.tokensOut) : release(env.DB, reservation));
    await insertLlmCall(env.DB, { ...log, status: result.kind, error: result.message, tokensIn: result.tokensIn, tokensOut: result.tokensOut });
    if (result.kind === "configuration_error" || result.kind === "insufficient_balance") {
      await pauseCircuit(env.DB, result.kind, now);
      return { status: "park" };
    }
    if (result.kind === "rate_limited") {
      await markRateLimited(env.DB, model, now, result.retryDelaySeconds);
      tried.add(model.model);
      continue;
    }
    if (result.kind === "invalid_request") return { status: "rejected" };
    if (result.kind === "transient" && result.httpStatus !== null && result.httpStatus >= 500) {
      // Briefly rest the unavailable model before the next queue delivery.
      serverError = result.kind;
      await restOverloaded(env.DB, model, now);
      tried.add(model.model);
      continue;
    }
    // Network failures or invalid output wait without bisecting otherwise valid items.
    await recordFailure(env.DB, result.kind, now);
    return parkForAvailability ? { status: "park" } : retryLater;
  }
}
