const FAILURES_BEFORE_BACKOFF = 5;
const MAX_INTERVAL_MIN = 24 * 60;

/**
 * Poll interval after `consecutiveFailures` failures in a row. From the fifth
 * failure the interval doubles per failure up to 24 hours; a success resets
 * the counter and with it the interval.
 */
export function pollIntervalMin(baseIntervalMin: number, consecutiveFailures: number): number {
  if (consecutiveFailures < FAILURES_BEFORE_BACKOFF) return baseIntervalMin;
  const doublings = consecutiveFailures - FAILURES_BEFORE_BACKOFF + 1;
  return Math.min(MAX_INTERVAL_MIN, baseIntervalMin * 2 ** Math.min(doublings, 16));
}

export function nextPollAt(now: number, baseIntervalMin: number, consecutiveFailures: number): number {
  return now + pollIntervalMin(baseIntervalMin, consecutiveFailures) * 60;
}
