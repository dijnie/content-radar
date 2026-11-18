export type FeedKind = "news" | "hands-on" | "deep-dives";
export type HandsOnCategory = "toolbox" | "field-tests" | "playbooks";

export interface SourceEvidence {
  itemId: number; url: string; title: string; source: string; author: string | null;
  platform: string; publishedAt: number; quote?: string;
  upvotes?: number | null; comments?: number | null;
}

export interface RepositoryFacts {
  fullName: string; stars: number; forks: number | null; starsToday: number | null;
  trendingRank: number | null; pushedAt: number | null; archived: boolean | null;
  license: string | null; capturedAt: number;
}

export interface EditorialEntry {
  key: string; category: "news" | HandsOnCategory | "deep-dives"; pillar: string;
  title: string; summary: string; question: string | null; findings: string[];
  score: number; publishedAt: number; sources: SourceEvidence[];
  voices: number; labLeaders: number | null; interactions: number | null;
  platforms: number; articles: number; repository: RepositoryFacts | null;
  scoreParts: Record<string, number | null>; read: boolean;
}

export interface Publication {
  runId: number; crawlId: number; publishedAt: number; total: number;
}
export interface EditorialFeedResponse {
  feed: FeedKind; publication: Publication | null; entries: EditorialEntry[];
  total: number; eligible: number; page: number; pageSize: number;
  counts: Record<string, number>; pillars: string[]; threshold: number | null;
  timezone: string; scoring: Record<string, unknown>; awaitingEditorial: number;
}

export interface FeedSchedule {
  feed: FeedKind; enabled: boolean; intervalMinutes: number; nextRunAt: number;
}
export interface JobRow {
  id: number; kind: "crawl" | FeedKind; status: string; trigger: string;
  startedAt: number; finishedAt: number | null; crawlId: number | null;
  sources: number; sourcesProcessed: number; sourcesRunning: number; failures: number; posts: number; articles: number;
  itemsNew: number; entries: number; stagedEntries: number; error: string | null;
}
export interface JobsResponse {
  crawls: JobRow[]; builds: JobRow[]; schedules: FeedSchedule[];
  total: number; page: number; pageSize: number; timezone: string;
}
