// Application request budgets retain their Pacific-day boundary across providers.
// This is a local spending policy, not a provider daily quota.
const PACIFIC = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Los_Angeles",
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});

function parts(epochSeconds: number): Record<string, string> {
  return Object.fromEntries(PACIFIC.formatToParts(new Date(epochSeconds * 1000)).map((part) => [part.type, part.value]));
}

function secondsSinceLocalMidnight(epochSeconds: number): number {
  const p = parts(epochSeconds);
  return Number(p.hour) * 3600 + Number(p.minute) * 60 + Number(p.second);
}

/** Pacific calendar day, `YYYY-MM-DD`. */
export function pacificDay(epochSeconds: number): string {
  const p = parts(epochSeconds);
  return `${p.year}-${p.month}-${p.day}`;
}

/** Epoch seconds of the next Pacific midnight, correct across 23- and 25-hour days. */
export function nextPacificMidnight(epochSeconds: number): number {
  let candidate = epochSeconds + 86_400 - secondsSinceLocalMidnight(epochSeconds);
  const drift = secondsSinceLocalMidnight(candidate);
  if (drift !== 0) candidate += drift < 43_200 ? -drift : 86_400 - drift;
  return candidate;
}
