export type StoryStatus = "lead" | "ready";
export type UserState = "inbox" | "saved" | "dismissed" | "written";
export type UserAction = "save" | "dismiss" | "written" | "restore";

export interface StoryRow {
  id: number;
  label_entity_id: number | null;
  label_text: string | null;
  headline_vi: string;
  headline_source: "fallback" | "llm";
  status: StoryStatus;
  score: number;
  subscores_json: string;
  independent_sources: number;
  questions_json: string;
  has_counter: number;
  topics_json: string;
  search_text: string;
  entity_signature_json: string;
  user_state: UserState;
  user_state_at: number | null;
  first_seen_at: number;
  last_claim_at: number;
  members_hash: string;
  synthesized_hash: string | null;
  synthesized_at: number | null;
  synthesis_attempts: number;
  alive: number;
  died_at: number | null;
}

const STATE_AFTER_ACTION: Record<UserAction, UserState> = {
  save: "saved",
  dismiss: "dismissed",
  written: "written",
  restore: "inbox",
};

export function getStory(db: D1Database, id: number): Promise<StoryRow | null> {
  return db.prepare("SELECT * FROM stories WHERE id = ?").bind(id).first<StoryRow>();
}

/** Applies a user action and logs it with the score at that moment, for later calibration. */
export async function applyUserAction(db: D1Database, storyId: number, action: UserAction, at: number): Promise<boolean> {
  const [update] = await db.batch([
    db.prepare("UPDATE stories SET user_state = ?, user_state_at = ? WHERE id = ?").bind(STATE_AFTER_ACTION[action], at, storyId),
    db
      .prepare(
        `INSERT INTO user_actions (story_id, action, at, score_at_action, subscores_json)
         SELECT id, ?2, ?3, score, subscores_json FROM stories WHERE id = ?1`,
      )
      .bind(storyId, action, at),
  ]);
  return (update?.meta.changes ?? 0) > 0;
}
