import type { CoreParams } from "../params.ts";

export interface StoryScoreInput {
  independentSources: number;
  /** Largest robust z among the story's posts; null when none could be judged. */
  maxVelocityZ: number | null;
  claims: readonly { hasNumbers: boolean; firstHand: boolean }[];
  hasCounter: boolean;
  /** Largest cosine between this story's centroid and any other living story's; 0 when it stands alone. */
  maxCosineToOtherStories: number;
  hoursSinceLatestClaim: number;
}

export interface Subscores {
  sources: number;
  velocity: number;
  specificity: number;
  counter: number;
  novelty: number;
  recency: number;
}

const clip = (value: number): number => Math.min(1, Math.max(0, value));

/** Transparent weighted sum, 0 to 100. Every term is a plain function of observable facts. */
export function scoreStory(input: StoryScoreInput, params: CoreParams): { score: number; subscores: Subscores } {
  const subscores: Subscores = {
    // Diminishing returns: the fifth source adds less than the second.
    sources: clip(Math.log2(1 + input.independentSources) / Math.log2(6)),
    velocity: input.maxVelocityZ === null ? 0.5 : 1 / (1 + Math.exp(-input.maxVelocityZ)),
    // Depends on facts about the claims, not on roles an LLM assigned.
    specificity: input.claims.length === 0 ? 0 : input.claims.filter((claim) => claim.hasNumbers || claim.firstHand).length / input.claims.length,
    counter: input.hasCounter ? 1 : 0,
    novelty: clip(1 - input.maxCosineToOtherStories),
    recency: Math.exp((-Math.LN2 * Math.max(0, input.hoursSinceLatestClaim)) / params.recencyHalfLifeHours),
  };
  const total =
    params.weightSources * subscores.sources + params.weightVelocity * subscores.velocity + params.weightSpecificity * subscores.specificity +
    params.weightCounter * subscores.counter + params.weightNovelty * subscores.novelty + params.weightRecency * subscores.recency;
  return { score: Math.round(100 * clip(total) * 10) / 10, subscores };
}

/** `ready` needs at least two independent sources; anything less is a lead to be checked. */
export function storyStatus(independentSources: number): "lead" | "ready" {
  return independentSources >= 2 ? "ready" : "lead";
}
