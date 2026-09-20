import type { CoreParams } from "../params.ts";

/** 1.4826 makes the MAD a consistent estimator of the standard deviation under normality. */
const MAD_SCALE = 1.4826;

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export function medianAbsoluteDeviation(values: readonly number[], centre = median(values)): number {
  return median(values.map((value) => Math.abs(value - centre)));
}

export interface AuthorBaseline {
  median: number;
  mad: number;
  sampleSize: number;
}

/**
 * How unusual a post's engagement is for its own author. A young post has not
 * collected its engagement yet, so it is projected to a 24-hour figure before
 * being compared with the author's matured baseline. Returns null when the post
 * is too young or the author has too little history to judge.
 */
export function velocityZ(engagement: number, ageHours: number, baseline: AuthorBaseline | null, params: Pick<CoreParams, "velocityMinBaseline" | "velocityMinAgeHours">): number | null {
  if (!baseline || baseline.sampleSize < params.velocityMinBaseline || ageHours < params.velocityMinAgeHours) return null;
  const projected = ageHours < 24 ? engagement / Math.max(0.25, ageHours / 24) : engagement;
  // An author whose posts all perform alike has MAD 0; fall back to a tenth of the median so z stays finite.
  const spread = MAD_SCALE * baseline.mad || Math.max(1, baseline.median * 0.1);
  return (projected - baseline.median) / spread;
}
