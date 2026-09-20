export type Tab = "inbox" | "saved" | "dismissed";
export type Sort = "score" | "newest";
export type UserState = "inbox" | "saved" | "dismissed" | "written";
export type StoryAction = "save" | "dismiss" | "written" | "restore";
export type ClaimRole = "evidence" | "context" | "counter" | "unassigned";

export interface ClaimLine {
  claimId: number;
  role: ClaimRole;
  textVi: string;
  quote: string;
  author: string | null;
  platform: string;
  url: string;
  publishedAt: number;
}

export interface StoryLink {
  url: string;
  author: string | null;
  platform: string;
}

export interface Story {
  id: number;
  label: string | null;
  headline: string;
  headlineSource: "fallback" | "llm";
  status: "lead" | "ready";
  score: number;
  independentSources: number;
  questions: string[];
  hasCounter: boolean;
  topics: string[];
  userState: UserState;
  alive: boolean;
  lastClaimAt: number;
  claims: ClaimLine[];
  claimCount: number;
  links: StoryLink[];
}

export interface Topic {
  slug: string;
  name: string;
}

export interface StoryListResponse {
  stories: Story[];
  nextCursor: string | null;
  counts: Record<Tab, number>;
  topics: Topic[];
  timezone: string;
}

export interface Filters {
  tab: Tab;
  topic: string | null;
  q: string;
  sort: Sort;
  view: "stories" | "status";
}

export const STATE_AFTER: Record<StoryAction, UserState> = { save: "saved", dismiss: "dismissed", written: "written", restore: "inbox" };
