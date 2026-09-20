import { canonicalizeUrl, canonicalLinks } from "./canonical-url";
import { hrefsIn, htmlToText } from "./feed-parser";
import { HttpError } from "./http-client";
import { cleanText, type AdapterContext, type NormalizedItem, type PollResult, type SourceAdapter } from "./source-adapter";

const ALGOLIA = "https://hn.algolia.com/api/v1/search_by_date";
const FIREBASE = "https://hacker-news.firebaseio.com/v0/item";
const STORIES_PER_QUERY = 20;
/** Only stories this hot get their comments crawled. */
const COMMENT_MIN_POINTS = 100;
const COMMENTS_PER_STORY = 10;
const STORIES_WITH_COMMENTS_PER_POLL = 3;

interface AlgoliaHit {
  objectID: string;
  title: string | null;
  url: string | null;
  author: string;
  points: number | null;
  num_comments: number | null;
  created_at_i: number;
  story_text?: string | null;
}

interface FirebaseItem {
  id: number;
  type?: string;
  by?: string;
  time?: number;
  text?: string;
  kids?: number[];
  dead?: boolean;
  deleted?: boolean;
}

const hnUrl = (id: string | number): string => `https://news.ycombinator.com/item?id=${id}`;

export function mapStory(hit: AlgoliaHit): NormalizedItem {
  const url = hnUrl(hit.objectID);
  const body = hit.story_text ? htmlToText(hit.story_text) : "";
  return {
    platform: "hn",
    externalId: hit.objectID,
    url,
    canonicalUrl: url,
    // The story's target is the origin several reports may share.
    links: canonicalLinks([...(hit.url ? [hit.url] : []), ...(hit.story_text ? hrefsIn(hit.story_text) : [])], url),
    author: { platform: "hn", handle: hit.author, displayName: null },
    kind: "story",
    parentExternalId: null,
    title: cleanText(hit.title),
    text: cleanText([hit.title, body].filter(Boolean).join("\n")),
    lang: "en",
    publishedAt: hit.created_at_i,
    raw: hit,
  };
}

export function mapComment(comment: FirebaseItem, storyId: string): NormalizedItem | null {
  if (comment.deleted || comment.dead || comment.type !== "comment" || !comment.by || !comment.text) return null;
  const url = hnUrl(comment.id);
  return {
    platform: "hn",
    externalId: String(comment.id),
    url,
    canonicalUrl: url,
    links: canonicalLinks(hrefsIn(comment.text), url),
    author: { platform: "hn", handle: comment.by, displayName: null },
    kind: "comment",
    parentExternalId: storyId,
    title: null,
    text: cleanText(htmlToText(comment.text)),
    lang: "en",
    publishedAt: comment.time ?? 0,
    raw: comment,
  };
}

/**
 * Top-level comments in the order of the story's `kids`, which is HN's own
 * ranking. Length is deliberately not a criterion: it would select exactly the
 * long payloads a prompt-injection attempt needs.
 */
async function rankedComments(storyId: string, ctx: AdapterContext): Promise<NormalizedItem[]> {
  const comments: NormalizedItem[] = [];
  // Comments are supplementary: a Firebase failure must not cost the poll its stories.
  const load = async (id: string | number): Promise<FirebaseItem | null> => {
    try {
      return await ctx.fetchJson<FirebaseItem | null>(`${FIREBASE}/${id}.json`);
    } catch (err) {
      if (err instanceof HttpError) return null;
      throw err;
    }
  };
  const story = await load(storyId);
  for (const kid of (story?.kids ?? []).slice(0, COMMENTS_PER_STORY)) {
    const comment = await load(kid);
    const mapped = comment ? mapComment(comment, storyId) : null;
    if (mapped) comments.push(mapped);
  }
  return comments;
}

export const hnAdapter: SourceAdapter = {
  type: "hn",
  async poll(source, ctx) {
    const url = new URL(ALGOLIA);
    url.searchParams.set("query", source.key);
    url.searchParams.set("tags", "story");
    url.searchParams.set("numericFilters", `points>${ctx.hnMinPoints}`);
    url.searchParams.set("hitsPerPage", String(STORIES_PER_QUERY));
    const { hits } = await ctx.fetchJson<{ hits: AlgoliaHit[] }>(url);

    const result: PollResult = { items: [], metrics: [] };
    let storiesWithComments = 0;
    for (const hit of hits) {
      result.items.push(mapStory(hit));
      result.metrics.push({ externalId: hit.objectID, points: hit.points, comments: hit.num_comments });
      if ((hit.points ?? 0) >= COMMENT_MIN_POINTS && storiesWithComments < STORIES_WITH_COMMENTS_PER_POLL) {
        storiesWithComments++;
        result.items.push(...(await rankedComments(hit.objectID, ctx)));
      }
    }
    return result;
  },
};
