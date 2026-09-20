import { listEnabledModels, type LlmKind, type LlmModelRow } from "../db/llm-repo";
import { getAllSettings } from "../db/settings-repo";
import { reserve, type BudgetSettings, type Reservation, type ReserveFailure } from "./budget-ledger";

export async function loadBudgetSettings(db: D1Database): Promise<BudgetSettings> {
  const settings = await getAllSettings(db);
  return {
    safeDefaultRpm: (settings.llm_safe_default_rpm as number | undefined) ?? 5,
    safeDefaultRpd: (settings.llm_safe_default_rpd as number | undefined) ?? 100,
    synthesisReservedShare: (settings.synthesis_reserved_share as number | undefined) ?? 0.2,
    backfillMaxShare: (settings.backfill_max_share as number | undefined) ?? 0.25,
  };
}

export type ChainResult = { ok: true; model: LlmModelRow; reservation: Reservation } | { ok: false; reason: ReserveFailure };

// When no model is available, report the mildest cause: a per-minute limit clears
// in seconds, a kind cap or the daily limit only at the next reset.
const SEVERITY: Record<ReserveFailure, number> = { rpm_exhausted: 0, kind_cap_reached: 1, rpd_exhausted: 2 };

/** First model by priority that is not parked and still has budget for this kind. `skip` holds models already tried for this call. */
export async function reserveOnChain(db: D1Database, kind: LlmKind, now: number, settings: BudgetSettings, skip: ReadonlySet<string> = new Set()): Promise<ChainResult> {
  let mildest: ReserveFailure = "rpd_exhausted";
  for (const model of await listEnabledModels(db)) {
    if (skip.has(model.model)) continue;
    if (model.exhausted_until !== null && model.exhausted_until > now) continue;
    const result = await reserve(db, model, kind, now, settings);
    if (result.ok) return { ok: true, model, reservation: result.reservation };
    if (SEVERITY[result.reason] < SEVERITY[mildest]) mildest = result.reason;
  }
  return { ok: false, reason: mildest };
}
