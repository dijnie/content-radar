import type { RepositoryFacts } from "@radar/core";
import { z } from "zod";

const weight = z.number().min(0).max(100);
export const editorialScoringSchema = z.object({
  newsMinScore: z.number().min(0).max(100),
  weights: z.object({ starsToday: weight, trendingRank: weight, adoption: weight, freshness: weight, health: weight })
    .refine((weights) => Math.abs(Object.values(weights).reduce((a, b) => a + b, 0) - 100) < 0.001, "weights must total 100"),
  starsTodayCap: z.number().positive(), starsCap: z.number().positive(), rankLimit: z.number().int().min(2), freshDays: z.number().positive(),
  labLeaderAuthorKeys: z.array(z.string()).default([]),
});
export type EditorialScoring = z.infer<typeof editorialScoringSchema>;

/** Missing facts earn no contribution and remain null; known weights are never inflated to cover gaps. */
export function scoreRepository(repo: RepositoryFacts, settings: EditorialScoring): { score: number; parts: Record<string, number | null> } {
  const cap = (n: number) => Math.min(1, Math.max(0, n));
  const log = (n: number, maximum: number) => cap(Math.log1p(Math.max(0, n)) / Math.log1p(maximum));
  const parts = {
    starsToday: repo.starsToday === null ? null : log(repo.starsToday, settings.starsTodayCap) * settings.weights.starsToday,
    trendingRank: repo.trendingRank === null ? null : cap((settings.rankLimit + 1 - repo.trendingRank) / settings.rankLimit) * settings.weights.trendingRank,
    adoption: log(repo.stars, settings.starsCap) * settings.weights.adoption,
    freshness: repo.pushedAt === null ? null : cap(1 - (repo.capturedAt - repo.pushedAt) / (settings.freshDays * 86400)) * settings.weights.freshness,
    health: repo.archived === null ? null : (repo.archived ? 0 : (repo.license && repo.license !== "NOASSERTION" ? 1 : 0.5)) * settings.weights.health,
  };
  const score = Math.round(Object.values(parts).reduce<number>((a, b) => a + (b ?? 0), 0) * 10) / 10;
  return { score, parts };
}
