import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { insertLlmCall, type LlmModelRow } from "../../src/db/llm-repo";
import { commit, markExhausted, release, remainingToday, reserve, type BudgetSettings } from "../../src/llm/budget-ledger";
import { circuitOpenUntil, recordFailure, recordSuccess } from "../../src/llm/circuit-breaker";
import { reserveOnChain } from "../../src/llm/model-chain";
import { nextPacificMidnight, pacificDay } from "../../src/llm/pacific-day";

const SETTINGS: BudgetSettings = { safeDefaultRpm: 5, safeDefaultRpd: 100, synthesisReservedShare: 0.2, backfillMaxShare: 0.25 };
const NOW = Date.UTC(2026, 8, 20, 18, 0, 0) / 1000; // 11:00 PDT
const model = (overrides: Partial<LlmModelRow> = {}): LlmModelRow => ({ model: "gemini-3.8-flash", priority: 1, rpm: 100, rpd: 10, tpm: null, enabled: 1, exhausted_until: null, ...overrides });
const requests = async (kind: string, day = pacificDay(NOW)) =>
  (await env.DB.prepare("SELECT requests FROM llm_usage WHERE day_pt = ? AND model = 'gemini-3.8-flash' AND kind = ?").bind(day, kind).first<{ requests: number }>())?.requests ?? 0;

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM llm_usage"),
    env.DB.prepare("DELETE FROM llm_calls"),
    env.DB.prepare("DELETE FROM settings WHERE key = 'llm_circuit'"),
    env.DB.prepare("UPDATE llm_models SET exhausted_until = NULL, rpm = NULL, rpd = NULL, enabled = 1"),
  ]);
});

describe("pacific day", () => {
  it("rolls over at Pacific midnight, not UTC midnight", () => {
    expect(pacificDay(Date.UTC(2026, 8, 21, 6, 59, 59) / 1000)).toBe("2026-09-20");
    expect(pacificDay(Date.UTC(2026, 8, 21, 7, 0, 0) / 1000)).toBe("2026-09-21");
    expect(nextPacificMidnight(NOW)).toBe(Date.UTC(2026, 8, 21, 7, 0, 0) / 1000);
  });

  it("handles the 23-hour day when daylight saving starts", () => {
    const before = Date.UTC(2026, 2, 8, 9, 0, 0) / 1000; // 01:00 PST on 8 March 2026
    expect(pacificDay(before)).toBe("2026-03-08");
    expect(nextPacificMidnight(before)).toBe(Date.UTC(2026, 2, 9, 7, 0, 0) / 1000); // 00:00 PDT
  });

  it("handles the 25-hour day when daylight saving ends", () => {
    const before = Date.UTC(2026, 10, 1, 8, 30, 0) / 1000; // 01:30 PDT on 1 November 2026
    expect(nextPacificMidnight(before)).toBe(Date.UTC(2026, 10, 2, 8, 0, 0) / 1000); // 00:00 PST
    expect(nextPacificMidnight(Date.UTC(2026, 10, 2, 8, 0, 0) / 1000)).toBe(Date.UTC(2026, 10, 3, 8, 0, 0) / 1000);
  });
});

describe("budget ledger", () => {
  it("creates the row on the first reservation of a new Pacific day", async () => {
    const yesterday = NOW - 86_400;
    for (let i = 0; i < 8; i++) expect((await reserve(env.DB, model(), "extract", yesterday, SETTINGS)).ok).toBe(true);
    expect(await reserve(env.DB, model(), "extract", yesterday, SETTINGS)).toEqual({ ok: false, reason: "kind_cap_reached" });

    expect((await reserve(env.DB, model(), "extract", NOW, SETTINGS)).ok).toBe(true);
    expect(await requests("extract")).toBe(1);
    expect(await requests("extract", pacificDay(yesterday))).toBe(8);
  });

  it("keeps 20% for synthesis and adjudication and caps backfill at 25%", async () => {
    // rpd 10: extraction may use 8 in total, backfill at most 2 of those.
    expect((await reserve(env.DB, model(), "extract_backfill", NOW, SETTINGS)).ok).toBe(true);
    expect((await reserve(env.DB, model(), "extract_backfill", NOW, SETTINGS)).ok).toBe(true);
    expect(await reserve(env.DB, model(), "extract_backfill", NOW, SETTINGS)).toEqual({ ok: false, reason: "kind_cap_reached" });
    for (let i = 0; i < 6; i++) expect((await reserve(env.DB, model(), "extract", NOW, SETTINGS)).ok).toBe(true);
    expect(await reserve(env.DB, model(), "extract", NOW, SETTINGS)).toEqual({ ok: false, reason: "kind_cap_reached" });
    expect(await remainingToday(env.DB, model(), "extract", NOW, SETTINGS)).toBe(0);

    expect(await remainingToday(env.DB, model(), "synthesize", NOW, SETTINGS)).toBe(2);
    expect((await reserve(env.DB, model(), "synthesize", NOW, SETTINGS)).ok).toBe(true);
    expect((await reserve(env.DB, model(), "adjudicate", NOW, SETTINGS)).ok).toBe(true);
    expect(await reserve(env.DB, model(), "synthesize", NOW, SETTINGS)).toEqual({ ok: false, reason: "rpd_exhausted" });
  });

  it("gives the slot back on release and keeps it on commit", async () => {
    const first = await reserve(env.DB, model(), "extract", NOW, SETTINGS);
    if (!first.ok) throw new Error("expected a reservation");
    await release(env.DB, first.reservation);
    expect(await requests("extract")).toBe(0);

    const second = await reserve(env.DB, model(), "extract", NOW, SETTINGS);
    if (!second.ok) throw new Error("expected a reservation");
    await commit(env.DB, second.reservation, 1200, 300);
    const row = await env.DB.prepare("SELECT requests, tokens_in, tokens_out FROM llm_usage WHERE kind = 'extract'").first();
    expect(row).toEqual({ requests: 1, tokens_in: 1200, tokens_out: 300 });
    await release(env.DB, second.reservation);
    await release(env.DB, second.reservation);
    expect(await requests("extract")).toBe(0);
  });

  it("tells a per-minute limit apart from a per-day limit", async () => {
    const slow = model({ rpm: 2, rpd: 1000 });
    for (let i = 0; i < 2; i++) await insertLlmCall(env.DB, { at: NOW - 10, model: slow.model, kind: "extract", promptVersion: 1, status: "ok" });
    expect(await reserve(env.DB, slow, "extract", NOW, SETTINGS)).toEqual({ ok: false, reason: "rpm_exhausted" });
    // A minute later the same request goes through: the wait is seconds, not hours.
    expect((await reserve(env.DB, slow, "extract", NOW + 55, SETTINGS)).ok).toBe(true);
  });

  it("falls back to the safe defaults while the real limits are unknown", async () => {
    expect(await remainingToday(env.DB, model({ rpm: null, rpd: null }), "extract", NOW, SETTINGS)).toBe(80);
  });

  it("parks a model until the next Pacific midnight, or one more hour when the reset was misjudged", async () => {
    expect(await markExhausted(env.DB, model(), NOW)).toBe(nextPacificMidnight(NOW));
    const midnight = nextPacificMidnight(NOW);
    expect(await markExhausted(env.DB, model({ exhausted_until: midnight }), midnight + 120)).toBe(midnight + 120 + 3600);
    expect(await remainingToday(env.DB, model({ exhausted_until: NOW + 10 }), "extract", NOW, SETTINGS)).toBe(0);
  });
});

describe("model chain", () => {
  it("uses the next model once the preferred one is parked or out of budget", async () => {
    await env.DB.prepare("UPDATE llm_models SET rpd = 10, rpm = 100").run();
    expect(await reserveOnChain(env.DB, "extract", NOW, SETTINGS)).toMatchObject({ ok: true, model: { model: "gemini-3.8-flash" } });
    await env.DB.prepare("UPDATE llm_models SET exhausted_until = ? WHERE model = 'gemini-3.8-flash'").bind(NOW + 3600).run();
    expect(await reserveOnChain(env.DB, "extract", NOW, SETTINGS)).toMatchObject({ ok: true, model: { model: "gemini-3.7-flash" } });
    expect(await reserveOnChain(env.DB, "extract", NOW, SETTINGS, new Set(["gemini-3.7-flash"]))).toMatchObject({ ok: true, model: { model: "gemini-3.6-flash" } });
  });

  it("reports the mildest reason when every model is unavailable", async () => {
    await env.DB.prepare("UPDATE llm_models SET rpd = 0, rpm = 100").run();
    expect(await reserveOnChain(env.DB, "extract", NOW, SETTINGS)).toEqual({ ok: false, reason: "rpd_exhausted" });
    await env.DB.prepare("UPDATE llm_models SET rpd = 10, rpm = 0 WHERE model = 'gemini-3.6-flash'").run();
    expect(await reserveOnChain(env.DB, "extract", NOW, SETTINGS)).toEqual({ ok: false, reason: "rpm_exhausted" });
  });
});

describe("circuit breaker", () => {
  it("opens for 15 minutes after five consecutive failures of the same kind", async () => {
    for (let i = 0; i < 4; i++) expect(await recordFailure(env.DB, "location_blocked", NOW)).toBe(false);
    expect(await circuitOpenUntil(env.DB, NOW)).toBeNull();
    expect(await recordFailure(env.DB, "location_blocked", NOW)).toBe(true);
    expect(await circuitOpenUntil(env.DB, NOW)).toBe(NOW + 900);
    expect(await circuitOpenUntil(env.DB, NOW + 901)).toBeNull();
  });

  it("resets the count on a success or a different failure kind", async () => {
    for (let i = 0; i < 4; i++) await recordFailure(env.DB, "transient", NOW);
    await recordSuccess(env.DB);
    for (let i = 0; i < 4; i++) await recordFailure(env.DB, "transient", NOW);
    expect(await recordFailure(env.DB, "location_blocked", NOW)).toBe(false);
    expect(await circuitOpenUntil(env.DB, NOW)).toBeNull();
  });
});
