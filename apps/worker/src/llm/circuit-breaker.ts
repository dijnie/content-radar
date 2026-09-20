import { getSetting, setSetting } from "../db/settings-repo";

const KEY = "llm_circuit";
const TRIP_AFTER = 5;
const OPEN_SECONDS = 15 * 60;

interface CircuitState {
  errorKind: string | null;
  count: number;
  openUntil: number;
}

const CLOSED: CircuitState = { errorKind: null, count: 0, openUntil: 0 };

export async function circuitOpenUntil(db: D1Database, now: number): Promise<number | null> {
  const state = (await getSetting<CircuitState>(db, KEY)) ?? CLOSED;
  return state.openUntil > now ? state.openUntil : null;
}

/** Five consecutive failures of the same non-quota kind pause all LLM work for 15 minutes. */
export async function recordFailure(db: D1Database, errorKind: string, now: number): Promise<boolean> {
  const state = (await getSetting<CircuitState>(db, KEY)) ?? CLOSED;
  const count = state.errorKind === errorKind ? state.count + 1 : 1;
  const tripped = count >= TRIP_AFTER;
  await setSetting(db, KEY, { errorKind: tripped ? null : errorKind, count: tripped ? 0 : count, openUntil: tripped ? now + OPEN_SECONDS : state.openUntil } satisfies CircuitState);
  return tripped;
}

export async function recordSuccess(db: D1Database): Promise<void> {
  const state = await getSetting<CircuitState>(db, KEY);
  if (state && (state.count > 0 || state.errorKind !== null)) await setSetting(db, KEY, { ...CLOSED, openUntil: state.openUntil });
}
