import { X_HANDLE_PATTERN } from "@radar/core";
import { canonicalizeUrl, canonicalLinks } from "./canonical-url";
import { parseFeed } from "./feed-parser";
import { HttpError } from "./http-client";
import { cleanText, type AdapterContext, type MetricSnapshot, type NormalizedItem, type PollResult, type SourceAdapter } from "./source-adapter";

const API_HOST = "api.fxtwitter.com";
const FEED_HOST = "fxtwitter.com";
const SYNDICATION_HOST = "cdn.syndication.twimg.com";
/** Statuses looked up one by one when the timeline API is down. */
const FALLBACK_STATUS_LIMIT = 8;

interface FxAuthor {
  screen_name: string;
  name?: string;
}

interface FxStatus {
  id: string;
  url: string;
  text: string;
  raw_text?: { facets?: { type: string; replacement?: string }[] };
  author: FxAuthor;
  replies?: number;
  reposts?: number;
  retweets?: number;
  likes?: number;
  bookmarks?: number;
  quotes?: number;
  views?: number | null;
  created_timestamp: number;
  lang?: string | null;
  replying_to?: { screen_name: string; status: string } | null;
  reposted_by?: FxAuthor | null;
  quote?: FxStatus | null;
}

interface FxTimeline {
  code: number;
  results?: FxStatus[];
  cursor?: { top?: string | null; bottom?: string | null } | null;
}

export function assertHandle(handle: string): string {
  if (!X_HANDLE_PATTERN.test(handle)) throw new HttpError("blocked", "invalid_handle");
  return handle;
}

/** Builds a URL and proves it still points at the expected host. */
function urlOn(host: string, path: string, params: Record<string, string> = {}): URL {
  const url = new URL(`https://${host}${path}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  if (url.host !== host) throw new HttpError("blocked", "unexpected_host");
  return url;
}

export function timelineUrl(handle: string, cursor?: string): URL {
  return urlOn(API_HOST, `/2/profile/${assertHandle(handle)}/statuses`, cursor ? { cursor } : {});
}

function metricsOf(externalId: string, status: FxStatus): MetricSnapshot {
  return {
    externalId,
    likes: status.likes ?? null,
    reposts: status.reposts ?? status.retweets ?? null,
    replies: status.replies ?? null,
    views: status.views ?? null,
    bookmarks: status.bookmarks ?? null,
    quotes: status.quotes ?? null,
  };
}

export function mapStatus(status: FxStatus): { item: NormalizedItem; metrics: MetricSnapshot | null } {
  const reposter = status.reposted_by ?? null;
  // A repost carries the original status. It is stored under the reposter with
  // its own id, so it never collides with the original in another timeline.
  const author = reposter ?? status.author;
  const externalId = reposter ? `${status.id}:rt:${reposter.screen_name.toLowerCase()}` : status.id;
  const url = canonicalizeUrl(status.url) ?? status.url;
  const linked = (status.raw_text?.facets ?? []).flatMap((facet) => (facet.type === "url" && facet.replacement ? [facet.replacement] : []));
  if (status.quote) linked.push(status.quote.url);

  const item: NormalizedItem = {
    platform: "x",
    externalId,
    // A repost points straight at the original status.
    url,
    canonicalUrl: url,
    links: canonicalLinks(linked, url),
    author: { platform: "x", handle: author.screen_name, displayName: author.name ?? null },
    kind: reposter ? "repost" : status.replying_to ? "reply" : status.quote ? "quote" : "post",
    parentExternalId: reposter ? status.id : (status.replying_to?.status ?? status.quote?.id ?? null),
    replyToHandle: reposter ? null : (status.replying_to?.screen_name ?? null),
    title: null,
    text: cleanText(status.text),
    lang: status.lang ?? null,
    publishedAt: status.created_timestamp,
    raw: status,
  };
  // Engagement of a repost belongs to the original author, not the reposter.
  return { item, metrics: reposter ? null : metricsOf(externalId, status) };
}

export function mapTimeline(timeline: FxTimeline): PollResult {
  const mapped = (timeline.results ?? []).map(mapStatus);
  return {
    items: mapped.map((entry) => entry.item),
    metrics: mapped.flatMap((entry) => (entry.metrics ? [entry.metrics] : [])),
    cursor: timeline.cursor ?? undefined,
  };
}

export async function fetchTimeline(handle: string, ctx: AdapterContext, cursor?: string): Promise<PollResult> {
  const timeline = await ctx.fetchJson<FxTimeline>(timelineUrl(handle, cursor));
  if (timeline.code !== 200 || !Array.isArray(timeline.results)) throw new HttpError("transient", `fxtwitter_code_${timeline.code}`);
  return mapTimeline(timeline);
}

// Token scheme used by the public embed widget.
export function syndicationToken(id: string): string {
  return ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, "");
}

/**
 * Timeline API down: discover statuses through the RSS feed, read each one
 * from the status API, and as a last resort take likes and replies from the
 * Syndication CDN while keeping the feed's text.
 */
async function pollViaFeed(handle: string, ctx: AdapterContext): Promise<PollResult> {
  const { text: xml } = await ctx.fetchText(urlOn(FEED_HOST, `/${assertHandle(handle)}/feed.xml`));
  const result: PollResult = { items: [], metrics: [] };

  for (const entry of parseFeed(xml, FALLBACK_STATUS_LIMIT).entries) {
    const id = /\/status\/(\d+)/.exec(entry.link)?.[1];
    if (!id) continue;
    try {
      const { tweet } = await ctx.fetchJson<{ tweet: FxStatus }>(urlOn(API_HOST, `/${handle}/status/${id}`));
      const mapped = mapStatus(tweet);
      result.items.push(mapped.item);
      if (mapped.metrics) result.metrics.push(mapped.metrics);
      continue;
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
    }

    const url = canonicalizeUrl(`https://x.com/${handle}/status/${id}`)!;
    result.items.push({
      platform: "x",
      externalId: id,
      url,
      canonicalUrl: url,
      links: [],
      author: { platform: "x", handle, displayName: null },
      kind: "post",
      parentExternalId: null,
      title: null,
      text: cleanText(entry.title),
      lang: null,
      publishedAt: entry.publishedAt ?? ctx.now,
      raw: entry,
    });
    try {
      const counts = await ctx.fetchJson<{ favorite_count?: number; conversation_count?: number }>(
        urlOn(SYNDICATION_HOST, "/tweet-result", { id, token: syndicationToken(id) }),
      );
      result.metrics.push({ externalId: id, likes: counts.favorite_count ?? null, replies: counts.conversation_count ?? null });
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
    }
  }
  return result;
}

export const xAdapter: SourceAdapter = {
  type: "x",
  async poll(source, ctx) {
    try {
      return await fetchTimeline(source.key, ctx);
    } catch (err) {
      // An invalid handle or a vanished account will not be fixed by a fallback.
      if (!(err instanceof HttpError) || err.reason === "invalid_handle" || err.kind === "not_found") throw err;
      return pollViaFeed(source.key, ctx);
    }
  },
};
