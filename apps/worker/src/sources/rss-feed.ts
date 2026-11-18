import { feedExternalId } from "../db/items-repo";
import { fetchArticleText } from "./article-text";
import { canonicalizeUrl, canonicalLinks } from "./canonical-url";
import { hrefsIn, htmlToText, parseFeed, type FeedEntry } from "./feed-parser";
import { cleanText, type AdapterContext, type NormalizedItem, type PollResult, type SourceAdapter } from "./source-adapter";
import { HUGGINGFACE_PAPERS_URL, pollHuggingfacePapers } from "./huggingface-papers";

/** Some feeds carry their whole archive (OpenAI: 1,200 items); only the head is new. */
export const FEED_ENTRIES_PER_POLL = 30;
export const FEED_MAX_BYTES = 5_000_000;
/** Feed text shorter than this is treated as a summary and the article is fetched. */
const SUMMARY_ONLY_BELOW = 600;
/** Entries older than this are archive, not news. */
const MAX_ENTRY_AGE_SECONDS = 30 * 86_400;

export async function mapFeedEntry(
  entry: FeedEntry,
  source: { id: number; key: string },
  kind: "article" | "release",
  ctx: AdapterContext,
): Promise<NormalizedItem | null> {
  const canonicalUrl = canonicalizeUrl(entry.link);
  if (!canonicalUrl) return null;
  const publishedAt = entry.publishedAt ?? ctx.now;
  if (ctx.now - publishedAt > MAX_ENTRY_AGE_SECONDS) return null;

  const title = cleanText(entry.title);
  const body = cleanText(htmlToText(entry.html));
  const externalId = await feedExternalId(source.id, entry.guid);
  let text = cleanText([title, body].filter(Boolean).join("\n"));
  let summaryOnly = false;
  if (kind === "article" && body.length < SUMMARY_ONLY_BELOW) {
    const cached = await ctx.readFeedItem?.(externalId, entry.publishedAt);
    const samePage = cached?.raw?.link === entry.link && cached.raw.title === entry.title;
    const oldTeaser = samePage ? cleanText([title, htmlToText(cached.raw.html)].filter(Boolean).join("\n")) : null;
    const fullText = samePage && oldTeaser !== null && cached.text.length > oldTeaser.length ? cached.text : null;
    if (fullText && cached?.raw.html === entry.html) {
      text = fullText;
    } else {
      const article = await fetchArticleText(entry.link, ctx);
      if (article && article.length > body.length) text = cleanText([title, article].filter(Boolean).join("\n"));
      else if (fullText) text = fullText;
      else summaryOnly = true;
    }
  }

  const platform = kind === "release" ? "github" : "rss";
  return {
    platform,
    // Scoped to the source: a guid is chosen by the feed and proves nothing about other feeds.
    externalId,
    url: entry.link,
    canonicalUrl,
    links: canonicalLinks(hrefsIn(entry.html), canonicalUrl),
    author: { platform, handle: kind === "release" ? source.key.split("/")[0]! : new URL(source.key).hostname, displayName: entry.author },
    kind,
    parentExternalId: null,
    title,
    text,
    lang: null,
    publishedAt,
    summaryOnly,
    raw: entry,
  };
}

export const rssAdapter: SourceAdapter = {
  type: "rss",
  async poll(source, ctx): Promise<PollResult> {
    if (source.key === HUGGINGFACE_PAPERS_URL) return pollHuggingfacePapers(source.id, ctx);
    const { text: xml } = await ctx.fetchText(source.key, { maxBytes: FEED_MAX_BYTES });
    const items: NormalizedItem[] = [];
    for (const entry of parseFeed(xml, FEED_ENTRIES_PER_POLL).entries) {
      const item = await mapFeedEntry(entry, source, "article", ctx);
      if (item) items.push(item);
    }
    return { items, metrics: [] };
  },
};
