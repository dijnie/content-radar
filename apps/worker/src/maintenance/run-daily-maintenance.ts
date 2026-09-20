import { resolveParams } from "@radar/core";
import { getSetting } from "../db/settings-repo";
import { updateAuthorBaselines } from "./author-baselines";
import { rebuildDailyAggregates } from "./daily-aggregates";
import { repairStaleState } from "./repair-stale-state";
import { applyRetention } from "./retention";

/** Daily job. Each part stands alone, so one failing part does not stop the others. */
export async function runDailyMaintenance(db: D1Database, now = Math.floor(Date.now() / 1000)): Promise<Record<string, string>> {
  const params = resolveParams((await getSetting<Record<string, unknown>>(db, "core_overrides")) ?? {});
  const parts: Record<string, () => Promise<unknown>> = {
    repair: () => repairStaleState(db, now),
    baselines: () => updateAuthorBaselines(db, now),
    aggregates: () => rebuildDailyAggregates(db, now),
    retention: () => applyRetention(db, now, params.windowDays),
  };
  const report: Record<string, string> = {};
  for (const [name, run] of Object.entries(parts)) {
    try {
      report[name] = JSON.stringify((await run()) ?? "ok");
    } catch (err) {
      report[name] = `failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300);
    }
  }
  console.log(JSON.stringify({ event: "daily_maintenance", ...report }));
  return report;
}
