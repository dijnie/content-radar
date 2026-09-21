import type { LlmKind, LlmModelRow } from "../db/llm-repo";
import { pacificDay } from "./pacific-day";

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
 * adjudication together get `synthesisReservedShare`. Request budget is limited
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

/** An HTTP response was received: count this attempt toward the application cap. */
export async function commit(db: D1Database, reservation: Reservation, tokensIn = 0, tokensOut = 0): Promise<void> {
  await db
    .prepare("UPDATE llm_usage SET tokens_in = tokens_in + ?, tokens_out = tokens_out + ? WHERE day_pt = ? AND model = ? AND kind = ?")
    .bind(tokensIn, tokensOut, reservation.dayPt, reservation.model, reservation.kind)
    .run();
}

/** The call received no HTTP response: give the application request slot back. */
export async function release(db: D1Database, reservation: Reservation): Promise<void> {
  await db
    .prepare("UPDATE llm_usage SET requests = requests - 1 WHERE day_pt = ? AND model = ? AND kind = ? AND requests > 0")
    .bind(reservation.dayPt, reservation.model, reservation.kind)
    .run();
}

/** DeepSeek 429 is temporary concurrency pressure, never a next-day quota reset. */
export async function markRateLimited(db: D1Database, model: LlmModelRow, now: number, retryDelaySeconds = 60): Promise<number> {
  const until = now + Math.max(1, Math.min(300, retryDelaySeconds));
  await db.prepare("UPDATE llm_models SET exhausted_until = MAX(COALESCE(exhausted_until, 0), ?) WHERE model = ?").bind(until, model.model).run();
  return until;
}

/** How long a model that answered with a server error is left alone. */
export const OVERLOAD_REST_SECONDS = 3 * 60;

/**
 * Rests an overloaded model. Every request to it costs one of the day's few, answered or not,
 * so asking again seconds later is the expensive way to learn that it is still overloaded.
 */
export async function restOverloaded(db: D1Database, model: LlmModelRow, now: number): Promise<void> {
  await db.prepare("UPDATE llm_models SET exhausted_until = MAX(COALESCE(exhausted_until, 0), ?) WHERE model = ?").bind(now + OVERLOAD_REST_SECONDS, model.model).run();
}
