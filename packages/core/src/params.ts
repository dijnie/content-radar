// Single owner of every algorithm parameter. The `settings` table may only
// override values through `core_overrides`; nothing in this package falls back
// to an implicit default of its own.

export const PARAMS_VERSION = 1;

export interface CoreParams {
  windowDays: number;

  cosineFloor: number;
  maxNeighboursPerClaim: number;
  wCos: number;
  wEnt: number;
  minEdgeWeight: number;
  hubEntityShare: number;

  quality: "cpm" | "modularity";
  resolution: number;
  seed: number;
  minCommunitySize: number;
  singletonMinVelocityZ: number;

  jaccardContinue: number;
  jaccardRelated: number;
  lookbackHours: number;
  reviveHorizonDays: number;
  reviveSignatureJaccard: number;

  aliasAutoAccept: number;
  aliasAutoReject: number;

  weightSources: number;
  weightVelocity: number;
  weightSpecificity: number;
  weightCounter: number;
  weightNovelty: number;
  weightRecency: number;
  recencyHalfLifeHours: number;
  velocityMinBaseline: number;
  velocityMinAgeHours: number;
}

export const DEFAULT_PARAMS: Readonly<CoreParams> = Object.freeze({
  windowDays: 7,

  cosineFloor: 0.55,
  maxNeighboursPerClaim: 30,
  wCos: 0.6,
  wEnt: 0.4,
  minEdgeWeight: 0.45,
  hubEntityShare: 0.15,

  quality: "cpm",
  // Chosen by the resolution sweep over the weighted fixtures; see resolution-sweep.test.ts.
  resolution: 0.5,
  seed: 42,
  minCommunitySize: 2,
  singletonMinVelocityZ: 3,

  jaccardContinue: 0.5,
  jaccardRelated: 0.3,
  lookbackHours: 24,
  reviveHorizonDays: 30,
  reviveSignatureJaccard: 0.5,

  aliasAutoAccept: 0.92,
  aliasAutoReject: 0.75,

  weightSources: 0.3,
  weightVelocity: 0.2,
  weightSpecificity: 0.15,
  weightCounter: 0.1,
  weightNovelty: 0.15,
  weightRecency: 0.1,
  recencyHalfLifeHours: 48,
  velocityMinBaseline: 10,
  velocityMinAgeHours: 3,
});

type Range = readonly [min: number, max: number, integer?: boolean];

const RANGES: Record<Exclude<keyof CoreParams, "quality">, Range> = {
  windowDays: [1, 60, true],
  cosineFloor: [0, 1],
  maxNeighboursPerClaim: [1, 200, true],
  wCos: [0, 1],
  wEnt: [0, 1],
  minEdgeWeight: [0, 1],
  hubEntityShare: [0.01, 1],
  resolution: [0.0001, 10],
  seed: [0, 2 ** 31 - 1, true],
  minCommunitySize: [2, 50, true],
  singletonMinVelocityZ: [0, 20],
  jaccardContinue: [0, 1],
  jaccardRelated: [0, 1],
  lookbackHours: [1, 24 * 14],
  reviveHorizonDays: [1, 365],
  reviveSignatureJaccard: [0, 1],
  aliasAutoAccept: [0, 1],
  aliasAutoReject: [0, 1],
  weightSources: [0, 1],
  weightVelocity: [0, 1],
  weightSpecificity: [0, 1],
  weightCounter: [0, 1],
  weightNovelty: [0, 1],
  weightRecency: [0, 1],
  recencyHalfLifeHours: [1, 24 * 30],
  velocityMinBaseline: [1, 1000, true],
  velocityMinAgeHours: [0, 72],
};

const SCORE_WEIGHTS = ["weightSources", "weightVelocity", "weightSpecificity", "weightCounter", "weightNovelty", "weightRecency"] as const;

/** Merges overrides over the defaults. Unknown keys and out-of-range values are refused, never ignored. */
export function resolveParams(overrides: Record<string, unknown> = {}): CoreParams {
  const params: CoreParams = { ...DEFAULT_PARAMS };
  const problems: string[] = [];
  for (const [key, value] of Object.entries(overrides)) {
    if (key === "quality") {
      if (value === "cpm" || value === "modularity") params.quality = value;
      else problems.push(`quality must be "cpm" or "modularity"`);
      continue;
    }
    const range = (RANGES as Record<string, Range | undefined>)[key];
    if (!range) {
      problems.push(`unknown parameter ${key}`);
      continue;
    }
    const [min, max, integer] = range;
    if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
      problems.push(`${key} must be ${integer ? "an integer" : "a number"} in [${min}, ${max}]`);
      continue;
    }
    (params as unknown as Record<string, number>)[key] = value;
  }
  if (params.jaccardRelated > params.jaccardContinue) problems.push("jaccardRelated must not exceed jaccardContinue");
  if (params.aliasAutoReject > params.aliasAutoAccept) problems.push("aliasAutoReject must not exceed aliasAutoAccept");
  if (Math.abs(params.wCos + params.wEnt - 1) > 1e-9) problems.push("wCos + wEnt must equal 1");
  if (Math.abs(SCORE_WEIGHTS.reduce((sum, key) => sum + params[key], 0) - 1) > 1e-9) problems.push("score weights must sum to 1");
  if (problems.length > 0) throw new RangeError(`invalid core parameters: ${problems.join("; ")}`);
  return params;
}
