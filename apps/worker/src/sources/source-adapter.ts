import type { Platform, RepositoryFacts } from "@radar/core";
import type { ItemKind } from "../db/items-repo";
import type { SourceRow } from "../db/sources-repo";
import type { HttpOptions, HttpTextResponse } from "./http-client";

export interface NormalizedAuthor {
  platform: Platform;
  handle: string;
  displayName: string | null;
}

export interface NormalizedItem {
  platform: Platform;
  externalId: string;
  url: string;
  canonicalUrl: string;
  /** URLs the item points at, canonicalized; written to item_links. */
  links: string[];
  author: NormalizedAuthor | null;
  kind: ItemKind;
  parentExternalId: string | null;
  /** Handle being replied to; lets the filter recognise a self-reply thread. */
  replyToHandle?: string | null;
  title: string | null;
  text: string;
  lang: string | null;
  publishedAt: number;
  /** Set when only the feed summary is available, not the article body. */
  summaryOnly?: boolean;
  repository?: RepositoryFacts;
  raw: unknown;
}

export interface MetricSnapshot {
  externalId: string;
  likes?: number | null;
  reposts?: number | null;
  replies?: number | null;
  views?: number | null;
  bookmarks?: number | null;
  quotes?: number | null;
  points?: number | null;
  comments?: number | null;
}

export interface PollResult {
  items: NormalizedItem[];
  metrics: MetricSnapshot[];
  cursor?: unknown;
}

export interface AdapterContext {
  now: number;
  githubToken: string | null;
  hnMinPoints: number;
  /** HTTP helpers pre-bound to the URL guard, the Worker's own hosts and the fetcher. */
  fetchText(url: string | URL, options?: HttpOptions): Promise<HttpTextResponse>;
  fetchJson<T>(url: string | URL, options?: HttpOptions): Promise<T>;
  /** Article downloads still allowed for this poll message. */
  articleBudget: { remaining: number };
}

export interface SourceAdapter {
  type: Platform;
  poll(source: SourceRow, ctx: AdapterContext): Promise<PollResult>;
}

// Crawled text is untrusted: control characters are removed so they cannot
// reach logs, prompts or the analyst session. Tab and newline survive.
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩﻿]/g;

export function cleanText(value: string | null | undefined): string {
  return (value ?? "")
    .replace(CONTROL_CHARS, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

export const TEXT_EXCERPT_MAX = 2000;
