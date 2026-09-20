import { resolveParams, scoreFromSubscores, type Subscores } from "@radar/core";
import { membersHash } from "../../cluster/lineage-step";
import { chunkedBatch } from "../../db/batch";
import { insertLlmCall } from "../../db/llm-repo";
import { getSetting } from "../../db/settings-repo";
import { budgetedCall, type BudgetedResult, type LlmDeps, type LlmEnv } from "../budgeted-call";
import { SYNTHESIZE_PROMPT_VERSION, SYNTHESIZE_SYSTEM_PROMPT, synthesizeUserPrompt, type SynthesisClaim } from "./synthesize-prompt";
import { SYNTHESIZE_JSON_SCHEMA, synthesizeResponseSchema } from "./synthesize-schema";

/** A very large story is summarised from its most recent claims. */
const MAX_CLAIMS_IN_PROMPT = 40;
const MIN_QUESTIONS = 2;
const MAX_QUESTIONS = 5;

export type SynthesisOutcome = Exclude<BudgetedResult, { status: "ok" }> | { status: "done" } | { status: "skipped" };

/**
 * Writes the LLM headline, claim roles and verification questions of a story.
 * It reads the story's members as they are now, not as they were when the job
 * was queued, and records the hash of exactly that set, so a story whose
 * membership moved on is still seen as needing synthesis next time.
 */
export async function synthesizeStory(env: LlmEnv, storyId: number, deps: LlmDeps = {}, attempt = 0): Promise<SynthesisOutcome> {
  const now = deps.now ?? Math.floor(Date.now() / 1000);
  const db = env.DB;
  const story = await db.prepare("SELECT id, alive, independent_sources, subscores_json FROM stories WHERE id = ?").bind(storyId).first<{ id: number; alive: number; independent_sources: number; subscores_json: string }>();
  if (!story || story.alive !== 1) return { status: "skipped" };

  const { results: members } = await db
    .prepare(
      `SELECT c.id AS claim_id, c.text_vi, c.quote, i.platform, COALESCE(a.canonical_name, 'unknown') AS author,
              (SELECT COALESCE(m.likes, 0) + COALESCE(m.reposts, 0) + COALESCE(m.replies, 0) + COALESCE(m.points, 0) + COALESCE(m.comments, 0)
               FROM item_metrics m WHERE m.item_id = i.id ORDER BY m.captured_at DESC LIMIT 1) AS engagement
       FROM story_claims sc JOIN claims c ON c.id = sc.claim_id JOIN items i ON i.id = c.item_id LEFT JOIN authors a ON a.id = c.author_id
       WHERE sc.story_id = ? AND sc.active = 1 ORDER BY c.published_at DESC, c.id`,
    )
    .bind(storyId)
    .all<{ claim_id: number; text_vi: string; quote: string; platform: string; author: string; engagement: number | null }>();
  if (members.length === 0) return { status: "skipped" };
  const activeIds = members.map((member) => member.claim_id);
  const sent: SynthesisClaim[] = members.slice(0, MAX_CLAIMS_IN_PROMPT).map((member) => ({ claimId: member.claim_id, author: member.author, platform: member.platform, textVi: member.text_vi, quote: member.quote, engagement: member.engagement }));

  const call = await budgetedCall(
    env,
    { kind: "synthesize", promptVersion: SYNTHESIZE_PROMPT_VERSION, system: SYNTHESIZE_SYSTEM_PROMPT, user: synthesizeUserPrompt(sent), schema: SYNTHESIZE_JSON_SCHEMA, subjectIds: [storyId] },
    { ...deps, now },
    attempt,
  );
  if (call.status !== "ok") return call;
  const parsed = synthesizeResponseSchema.safeParse(call.data);
  if (!parsed.success) {
    await insertLlmCall(db, { ...call.log, status: "invalid_output", error: "response did not match the schema" });
    return { status: "rejected" };
  }
  await insertLlmCall(db, call.log);

  // Roles apply only to claims that were sent; an id the model invented is ignored, not fatal.
  const sentIds = new Set(sent.map((claim) => claim.claimId));
  const roles = new Map<number, string>();
  for (const { claimId, role } of parsed.data.roles) if (sentIds.has(claimId)) roles.set(claimId, role);
  const setRole = db.prepare("UPDATE story_claims SET role = ? WHERE story_id = ? AND claim_id = ? AND active = 1");
  await chunkedBatch(db, [...roles].map(([claimId, role]) => setRole.bind(role, storyId, claimId)));

  const hasCounter = ((await db.prepare("SELECT COUNT(*) AS n FROM story_claims WHERE story_id = ? AND active = 1 AND role = 'counter'").bind(storyId).first<{ n: number }>())?.n ?? 0) > 0;
  // A counterpoint changes S_counter, so the score is recomputed from the stored sub-scores.
  const subscores = { ...(JSON.parse(story.subscores_json) as Subscores), counter: hasCounter ? 1 : 0 };
  const params = resolveParams((await getSetting<Record<string, unknown>>(db, "core_overrides")) ?? {});
  const questions = parsed.data.questions.slice(0, MAX_QUESTIONS);
  const lastRun = await db.prepare("SELECT MAX(id) AS id FROM cluster_runs WHERE status = 'done'").first<{ id: number | null }>();

  await db
    .prepare(
      `UPDATE stories SET headline_vi = ?, headline_source = 'llm', questions_json = ?, has_counter = ?, score = ?, subscores_json = ?,
         synthesized_hash = ?, synthesized_at = ?, synthesized_sources = ?, synthesized_run_id = ?
       WHERE id = ? AND alive = 1`,
    )
    .bind(
      parsed.data.headline_vi, JSON.stringify(questions.length >= MIN_QUESTIONS ? questions : []), hasCounter ? 1 : 0, scoreFromSubscores(subscores, params),
      JSON.stringify(subscores), await membersHash(activeIds), now, story.independent_sources, lastRun?.id ?? null, storyId,
    )
    .run();
  return { status: "done" };
}
