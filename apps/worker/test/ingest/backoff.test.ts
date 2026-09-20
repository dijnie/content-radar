import { describe, expect, it } from "vitest";
import { nextPollAt, pollIntervalMin } from "../../src/ingest/backoff";

describe("pollIntervalMin", () => {
  it.each([
    [0, 30], [4, 30], [5, 60], [6, 120], [7, 240], [8, 480], [9, 960], [10, 1440], [50, 1440],
  ])("after %i consecutive failures a 30-minute source waits %i minutes", (failures, expected) => {
    expect(pollIntervalMin(30, failures)).toBe(expected);
  });

  it("never exceeds 24 hours and shrinks back on success", () => {
    expect(pollIntervalMin(720, 6)).toBe(1440);
    expect(nextPollAt(1000, 30, 9)).toBe(1000 + 960 * 60);
    expect(nextPollAt(1000, 30, 0)).toBe(1000 + 30 * 60);
  });
});
