import type { LlmKind, LlmModelRow } from "../db/llm-repo";
import { nextPacificMidnight, pacificDay } from "./pacific-day";

export interface BudgetSettings {
  safeDefaultRpm: number;
  safeDefaultRpd: number;
  /** Share of the daily requests reserved for synthesize and adjudicate. */
  synthesisReservedShare: number;
  /** Largest share of the daily requests that backfill extraction may use. */
  backfillMaxShare: number;
}

export type ReserveFailure = "rpm_exhausted" | "rpd_exhausted" | "kind_cap_reached";
export interface Reservation {
  dayPt: string;
  model: string;
  kind: LlmKind;
}
export type ReserveResult = { ok: true; reservation: Reservation } | { ok: false; reason: ReserveFailure };

/** A 429 this soon after the assumed reset means the real reset is later than assumed. */
const RESET_DOUBT_WINDOW_SECONDS = 6 * 3600;
const EXTRACT_KINDS: readonly LlmKind[] = ["extract", "extract_backfill"];

export function limitsOf(model: LlmModelRow, settings: BudgetSettings): { rpm: number; rpd: number } {
  return { rpm: model.rpm ?? settings.safeDefaultRpm, rpd: model.rpd ?? settings.safeDefaultRpd };
}

async function usageByKind(db: D1Database, dayPt: string, model: string): Promise<Record<LlmKind, number>> {
  const usage: Record<LlmKind, number> = { extract: 0, extract_backfill: 0, synthesize: 0, adjudicate: 0 };
  const { results } = await db.prepare("SELECT kind, requests FROM llm_usage WHERE day_pt = ? AND model = ?").bind(dayPt, model).all<{ kind: LlmKind; requests: number }>();
  for (const row of results) usage[row.kind] = row.requests;
  return usage;
}

/**
 * Requests of this kind still allowed today on this model, ignoring the per-minute
 * limit. The day is split into two shares that never borrow from each other:
 * extraction (live plus backfill) gets `1 - synthesisReservedShare`, synthesis and
 * adjudication together get `synthesisReservedShare`. Quota is the scarce resource
 * and extraction is the pipeline, so the smaller share is a ceiling for its kinds,
 * not only a floor. Backfill is further capped inside the extraction share.
 */
export function remainingForKind(usage: Record<LlmKind, number>, kind: LlmKind, rpd: number, settings: BudgetSettings): number {
  const total = Object.values(usage).reduce((sum, value) => sum + value, 0);
  const overall = rpd - total;
  if (!EXTRACT_KINDS.includes(kind)) {
    return Math.max(0, Math.min(overall, Math.floor(rpd * settings.synthesisReservedShare) - usage.synthesize - usage.adjudicate));
  }
  const extractCap = Math.floor(rpd * (1 - settings.synthesisReservedShare));
  let remaining = Math.min(overall, extractCap - usage.extract - usage.extract_backfill);
  if (kind === "extract_backfill") remaining = Math.min(remaining, Math.floor(rpd * settings.backfillMaxShare) - usage.extract_backfill);
  return Math.max(0, remaining);
}

/** What is left today of the share that synthesis and adjudication draw on together. */
export function reservedRemainingToday(db: D1Database, model: LlmModelRow, now: number, settings: BudgetSettings): Promise<number> {
  return remainingToday(db, model, "synthesize", now, settings);
}

export async function remainingToday(db: D1Database, model: LlmModelRow, kind: LlmKind, now: number, settings: BudgetSettings): Promise<number> {
  if (model.exhausted_until !== null && model.exhausted_until > now) return 0;
  return remainingForKind(await usageByKind(db, pacificDay(now), model.model), kind, limitsOf(model, settings).rpd, settings);
}

/**
 * Reserves one request before the call. The row is created by the statement
 * itself, so the first reservation of a new Pacific day needs no seeding.
 */
export async function reserve(db: D1Database, model: LlmModelRow, kind: LlmKind, now: number, settings: BudgetSettings): Promise<ReserveResult> {
  const { rpm, rpd } = limitsOf(model, settings);
  const dayPt = pacificDay(now);
  const usage = await usageByKind(db, dayPt, model.model);
  const total = Object.values(usage).reduce((sum, value) => sum + value, 0);
  if (total >= rpd) return { ok: false, reason: "rpd_exhausted" };
  const remaining = remainingForKind(usage, kind, rpd, settings);
  if (remaining <= 0) return { ok: false, reason: "kind_cap_reached" };

  const recent = await db.prepare("SELECT COUNT(*) AS n FROM llm_calls WHERE model = ? AND at > ?").bind(model.model, now - 60).first<{ n: number }>();
  if ((recent?.n ?? 0) >= rpm) return { ok: false, reason: "rpm_exhausted" };

  // The guard repeats the cap inside the write, so a concurrent reservation cannot overshoot.
  const row = await db
    .prepare(
      `INSERT INTO llm_usage (day_pt, model, kind, requests) VALUES (?1, ?2, ?3, 1)
       ON CONFLICT(day_pt, model, kind) DO UPDATE SET requests = requests + 1 WHERE requests < ?4
       RETURNING requests`,
    )
    .bind(dayPt, model.model, kind, usage[kind] + remaining)
    .first<{ requests: number }>();
  return row ? { ok: true, reservation: { dayPt, model: model.model, kind } } : { ok: false, reason: "kind_cap_reached" };
}

/** The call reached Gemini (200, 429 or a rejected request): the reservation stands. */
export async function commit(db: D1Database, reservation: Reservation, tokensIn = 0, tokensOut = 0): Promise<void> {
  await db
    .prepare("UPDATE llm_usage SET tokens_in = tokens_in + ?, tokens_out = tokens_out + ? WHERE day_pt = ? AND model = ? AND kind = ?")
    .bind(tokensIn, tokensOut, reservation.dayPt, reservation.model, reservation.kind)
    .run();
}

/** The call never counted against Google's quota: give the reservation back. */
export async function release(db: D1Database, reservation: Reservation): Promise<void> {
  await db
    .prepare("UPDATE llm_usage SET requests = requests - 1 WHERE day_pt = ? AND model = ? AND kind = ? AND requests > 0")
    .bind(reservation.dayPt, reservation.model, reservation.kind)
    .run();
}

/**
 * Parks a model after a 429 until the next Pacific midnight. If the 429 comes
 * right after a reset we believed in, the real reset is later than assumed, so
 * the model is parked for one more hour instead of a whole day.
 */
export async function markExhausted(db: D1Database, model: LlmModelRow, now: number): Promise<number> {
  const previous = model.exhausted_until;
  const resetWasWrong = previous !== null && previous <= now && now - previous < RESET_DOUBT_WINDOW_SECONDS;
  const until = resetWasWrong ? now + 3600 : nextPacificMidnight(now);
  await db.prepare("UPDATE llm_models SET exhausted_until = ? WHERE model = ?").bind(until, model.model).run();
  return until;
}
