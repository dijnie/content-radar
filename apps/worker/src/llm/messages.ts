/** Wake-up messages on `radar-llm`. D1 holds the work itself; a lost message loses nothing. */
export type LlmMessage =
  | { kind: "extract"; itemId: number; backfill?: boolean }
  | { kind: "synthesize"; storyId: number; membersHash: string }
  | { kind: "adjudicate"; adjudicationIds: number[] };

/** Wake-up message on `radar-poll`: one source per message. */
export interface PollMessage {
  sourceId: number;
}
