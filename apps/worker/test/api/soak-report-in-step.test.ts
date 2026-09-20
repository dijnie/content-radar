import { describe, expect, it } from "vitest";
import { STATUS_QUERIES } from "../../src/api/status-route";
import soakReport from "../../../../scripts/soak-report.sql?raw";

const squash = (sql: string) => sql.replace(/\s+/g, " ").trim();

describe("scripts/soak-report.sql", () => {
  // `usageToday` takes the Pacific day as a bind, which a plain SQL file cannot do; the report has its own 8-day version.
  it.each(Object.entries(STATUS_QUERIES).filter(([name]) => name !== "usageToday"))("contains the status query %s verbatim", (_name, sql) => {
    expect(squash(soakReport)).toContain(squash(sql));
  });
});
