import { chunkForParams, placeholders } from "../../db/batch";
import { finishLlmCall } from "../../db/llm-repo";
import { budgetedCall, type BudgetedResult, type LlmDeps, type LlmEnv } from "../budgeted-call";
import { ADJUDICATE_PROMPT_VERSION, ADJUDICATE_SYSTEM_PROMPT, adjudicateUserPrompt } from "./adjudicate-prompt";
import { ADJUDICATE_JSON_SCHEMA, adjudicateResponseSchema } from "./adjudicate-schema";

type Decision = "same" | "version_of" | "different";

interface PendingRow {
  id: number;
  mention_normalized: string;
  provisional_entity_id: number;
  candidate_entity_id: number;
  mention: string;
  candidate: string;
  candidate_type: string;
}

export type AdjudicationOutcome = Exclude<BudgetedResult, { status: "ok" }> | { status: "done"; decided: number };

/** Applies one verdict. Edges are rebuilt from the entity resolution on every run, so a verdict takes effect at the next cluster run. */
export async function applyDecision(db: D1Database, row: Pick<PendingRow, "id" | "provisional_entity_id" | "candidate_entity_id">, decision: Decision, now: number): Promise<void> {
  const provisional = row.provisional_entity_id;
  const candidate = row.candidate_entity_id;
  const decided = db.prepare("UPDATE entity_adjudications SET status = 'decided', decision = ?, decided_at = ? WHERE id = ?").bind(decision, now, row.id);

  if (decision !== "same") {
    await db.batch([
      decision === "version_of"
        ? db.prepare("UPDATE entities SET provisional = 0, parent_entity_id = ? WHERE id = ?").bind(candidate, provisional)
        : db.prepare("UPDATE entities SET provisional = 0 WHERE id = ?").bind(provisional),
      ...(decision === "version_of" ? [db.prepare("INSERT INTO entity_relations (entity_id, related_entity_id, relation_type) VALUES (?, ?, 'version_of') ON CONFLICT DO NOTHING").bind(provisional, candidate)] : []),
      db.prepare("UPDATE entity_mentions SET provisional = 0 WHERE entity_id = ?").bind(provisional),
      decided,
    ]);
    return;
  }
  // Same entity: everything that pointed at the provisional entity moves to the candidate, then the provisional one goes.
  await db.batch([
    db.prepare("UPDATE entity_mentions SET entity_id = ?, provisional = 0 WHERE entity_id = ?").bind(candidate, provisional),
    db.prepare("UPDATE entity_aliases SET entity_id = ?, source = 'llm' WHERE entity_id = ?").bind(candidate, provisional),
    db.prepare("UPDATE stories SET label_entity_id = ? WHERE label_entity_id = ?").bind(candidate, provisional),
    db.prepare("UPDATE entity_adjudications SET provisional_entity_id = candidate_entity_id WHERE provisional_entity_id = ?").bind(provisional),
    db.prepare("UPDATE entity_adjudications SET candidate_entity_id = ? WHERE candidate_entity_id = ?").bind(candidate, provisional),
    db.prepare("DELETE FROM entity_embeddings WHERE entity_id = ?").bind(provisional),
    db.prepare("DELETE FROM entity_daily WHERE entity_id = ?").bind(provisional),
    db.prepare("DELETE FROM entity_relations WHERE entity_id = ?1 OR related_entity_id = ?1").bind(provisional),
    db.prepare("UPDATE entities SET parent_entity_id = ? WHERE parent_entity_id = ?").bind(candidate, provisional),
    decided,
    db.prepare("DELETE FROM entities WHERE id = ? AND provisional = 1").bind(provisional),
  ]);
}

export async function adjudicateEntities(env: LlmEnv, adjudicationIds: readonly number[], deps: LlmDeps = {}, attempt = 0): Promise<AdjudicationOutcome> {
  const now = deps.now ?? Math.floor(Date.now() / 1000);
  const db = env.DB;
  const rows: PendingRow[] = [];
  for (const chunk of chunkForParams(adjudicationIds)) {
    const { results } = await db
      .prepare(
        `SELECT j.id, j.mention_normalized, j.provisional_entity_id, j.candidate_entity_id, p.canonical_name AS mention, c.canonical_name AS candidate, c.type AS candidate_type
         FROM entity_adjudications j JOIN entities p ON p.id = j.provisional_entity_id JOIN entities c ON c.id = j.candidate_entity_id
         WHERE j.status != 'decided' AND j.id IN (${placeholders(chunk.length)}) ORDER BY j.id`,
      )
      .bind(...chunk)
      .all<PendingRow>();
    rows.push(...results);
  }
  if (rows.length === 0) return { status: "done", decided: 0 };

  const call = await budgetedCall(
    env,
    { kind: "adjudicate", promptVersion: ADJUDICATE_PROMPT_VERSION, system: ADJUDICATE_SYSTEM_PROMPT, schema: ADJUDICATE_JSON_SCHEMA, subjectIds: rows.map((row) => row.id),
      user: adjudicateUserPrompt(rows.map((row) => ({ id: row.id, mention: row.mention, candidate: row.candidate, candidateType: row.candidate_type }))) },
    deps,
    attempt,
  );
  if (call.status === "park") {
    // No budget today: hand the rows back so the next cluster run queues them again.
    await db.prepare(`UPDATE entity_adjudications SET status = 'pending' WHERE status = 'queued' AND id IN (${rows.map((row) => row.id).join(",")})`).run();
    return call;
  }
  if (call.status === "retry") return call;

  const parsed = call.status === "ok" ? adjudicateResponseSchema.safeParse(call.data) : null;
  if (call.status === "ok") await finishLlmCall(db, call.logId, { ...call.log, status: parsed?.success ? "ok" : "invalid_output" });
  const verdicts = new Map((parsed?.success ? parsed.data.decisions : []).map((entry) => [entry.id, entry.decision]));
  // No usable verdict means no merge: keeping two entities apart is the reversible mistake.
  for (const row of rows) await applyDecision(db, row, verdicts.get(row.id) ?? "different", now);
  return { status: "done", decided: rows.length };
}
