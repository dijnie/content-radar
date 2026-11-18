import { listEnabledModels } from "../db/llm-repo";
import { getSetting } from "../db/settings-repo";
import { reservedRemainingToday } from "../llm/budget-ledger";
import type { LlmMessage } from "../llm/messages";
import { loadBudgetSettings } from "../llm/model-chain";
import type { JobContext } from "./job-context";
import { ADJUDICATIONS_PER_MESSAGE } from "./resolve-entities-step";

const MIN_HOURS_BETWEEN_SYNTHESES = 6;
const NEW_STORY_HOURS = 6;
const MAX_ATTEMPTS_PER_MEMBERSHIP = 3;
const NEW_MEMBER_SHARE = 0.3;
const SHARE_FOR_NEW_STORIES = 0.3;

interface Candidate {
  id: number;
  score: number;
  first_seen_at: number;
  members_hash: string;
}

/**
 * Picks the stories worth one of today's few synthesis calls. A story qualifies
 * when it changed materially since its last synthesis: never synthesised, a
 * different number of independent sources, or at least 30% new members. 70% of
 * the slots go by score and 30% to stories younger than six hours, so an
 * emerging story is not starved by the big ones.
 */
export async function enqueueSynthesisStep(ctx: JobContext): Promise<number> {
  const { db, now } = ctx;
  const settings = await loadBudgetSettings(db);
  let budget = 0;
  // Only the reserved share is planned for, and adjudication draws on the same share.
  for (const model of await listEnabledModels(db)) budget += await reservedRemainingToday(db, model, now, settings);
  // Adjudications already queued will spend from the same share before these run.
  const queued = await db.prepare("SELECT COUNT(*) AS n FROM entity_adjudications WHERE status = 'queued'").first<{ n: number }>();
  budget -= Math.ceil((queued?.n ?? 0) / ADJUDICATIONS_PER_MESSAGE);
  if (budget <= 0) return 0;
  const minScore = (await getSetting<number>(db, "synthesis_min_score")) ?? 30;

  const { results } = await db
    .prepare(
      `SELECT s.id, s.score, s.first_seen_at, s.members_hash FROM stories s
       WHERE s.alive = 1 AND s.score >= ?1 AND s.user_state != 'dismissed'
         AND (s.synthesized_hash IS NULL OR s.synthesized_hash != s.members_hash)
         AND (s.synthesized_at IS NULL OR s.synthesized_at <= ?2)
         AND s.synthesis_attempts < ?3
         AND (
           s.synthesized_at IS NULL
           OR s.independent_sources != COALESCE(s.synthesized_sources, -1)
           OR (SELECT COUNT(*) FROM story_claims sc WHERE sc.story_id = s.id AND sc.active = 1 AND sc.added_run_id > COALESCE(s.synthesized_run_id, 0))
              >= ?4 * (SELECT COUNT(*) FROM story_claims sc WHERE sc.story_id = s.id AND sc.active = 1)
         )
       ORDER BY s.score DESC, s.id`,
    )
    .bind(minScore, now - MIN_HOURS_BETWEEN_SYNTHESES * 3600, MAX_ATTEMPTS_PER_MEMBERSHIP, NEW_MEMBER_SHARE)
    .all<Candidate>();

  const isNew = (story: Candidate) => now - story.first_seen_at < NEW_STORY_HOURS * 3600;
  const slotsForNew = Math.min(results.filter(isNew).length, Math.max(1, Math.round(budget * SHARE_FOR_NEW_STORIES)));
  const chosen = new Map<number, Candidate>();
  for (const story of results.filter(isNew).slice(0, slotsForNew)) chosen.set(story.id, story);
  for (const story of results) {
    if (chosen.size >= budget) break;
    chosen.set(story.id, story);
  }

  for (const story of chosen.values()) {
    await db.prepare("UPDATE stories SET synthesis_attempts = synthesis_attempts + 1 WHERE id = ?").bind(story.id).run();
    await ctx.env.LLM_QUEUE.send({ kind: "synthesize", storyId: story.id, membersHash: story.members_hash } satisfies LlmMessage);
  }
  return chosen.size;
}
