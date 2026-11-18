import { upsertAuthorByHandle } from "../db/authors-repo";
import { chunkedBatch } from "../db/batch";
import { getItemStates, insertItemLinks, insertMetricSnapshot, upsertItemStatement, type IngestMode } from "../db/items-repo";
import { getAllSettings } from "../db/settings-repo";
import { getSource, getSourceHealth, insertPollLog, recordPollError, recordPollOk, scheduleNextPoll, type SourceRow } from "../db/sources-repo";
import type { Env } from "../env";
import { claimCrawlSource, finishCrawlSource } from "../jobs/crawl-runs";
import { recordCrawlItems } from "../jobs/crawl-snapshots";
import { extractionWindowStart } from "../llm/extraction-priority";
import type { LlmMessage, PollMessage } from "../llm/messages";
import type { FeedEntry } from "../sources/feed-parser";
import { githubAdapter } from "../sources/github";
import { hnAdapter } from "../sources/hacker-news";
import { fetchJson, fetchText, HttpError, type HttpOptions } from "../sources/http-client";
import { rssAdapter } from "../sources/rss-feed";
import { TEXT_EXCERPT_MAX, type AdapterContext, type PollResult, type SourceAdapter } from "../sources/source-adapter";
import { xAdapter } from "../sources/x-fxtwitter";
import { sha256Hex } from "../util/hash";
import { nextPollAt } from "./backoff";
import { cheapFilter, type FilterConfig } from "./cheap-filter";

export const ADAPTERS: Record<SourceRow["type"], SourceAdapter> = { x: xAdapter, hn: hnAdapter, rss: rssAdapter, github: githubAdapter };

const ARTICLE_DOWNLOADS_PER_POLL = 5;
const SEND_BATCH_SIZE = 100;

export type IngestEnv = Pick<Env, "DB" | "RAW" | "LLM_QUEUE" | "GITHUB_TOKEN" | "APP_ORIGIN">;

export interface IngestDeps {
  now?: number;
  fetcher?: typeof fetch;
  adapters?: Partial<Record<SourceRow["type"], SourceAdapter>>;
  crawl?: { id: number; token: string };
}

function ownHosts(env: Pick<Env, "APP_ORIGIN">): string[] {
  try {
    return [new URL(env.APP_ORIGIN ?? "").hostname];
  } catch {
    return [];
  }
}

export async function buildAdapterContext(env: IngestEnv, now: number, fetcher?: typeof fetch): Promise<{ ctx: AdapterContext; filter: FilterConfig }> {
  const settings = await getAllSettings(env.DB);
  const { results: topics } = await env.DB.prepare("SELECT slug, keywords_json FROM topics WHERE enabled = 1").all<{ slug: string; keywords_json: string }>();
  const bound = (options?: HttpOptions): HttpOptions => ({ ...options, ownHosts: ownHosts(env), ...(fetcher ? { fetcher } : {}) });
  return {
    ctx: {
      now,
      githubToken: env.GITHUB_TOKEN || null,
      hnMinPoints: (settings.hn_min_points as number | undefined) ?? 20,
      fetchText: (url, options) => fetchText(url, bound(options)),
      fetchJson: (url, options) => fetchJson(url, bound(options)),
      async readFeedItem(externalId, publishedAt) {
        const key = publishedAt === null
          ? await env.DB.prepare("SELECT raw_r2_key FROM items WHERE platform = 'rss' AND external_id = ?").bind(externalId).first<string>("raw_r2_key")
          : rawKey("rss", publishedAt, await sha256Hex(externalId));
        if (!key) return null;
        const object = await env.RAW.get(key);
        return object ? object.json<{ text: string; raw: FeedEntry }>() : null;
      },
      articleBudget: { remaining: ARTICLE_DOWNLOADS_PER_POLL },
    },
    filter: {
      languages: (settings.filter_languages as string[] | undefined) ?? ["en", "vi"],
      minTextLength: (settings.filter_min_text_length as number | undefined) ?? 40,
      topics: topics.map((topic) => ({ slug: topic.slug, keywords: JSON.parse(topic.keywords_json) as string[] })),
    },
  };
}

function rawKey(platform: string, publishedAt: number, externalIdHash: string): string {
  const day = new Date(publishedAt * 1000).toISOString().slice(0, 10).replaceAll("-", "/");
  return `raw/${platform}/${day}/${externalIdHash}.json`;
}

/**
 * Stores one poll result. Order matters: raw payload to R2, then one D1 batch
 * that writes each new item together with its final state, then the wake-up
 * messages. A crash after the batch leaves `queued` rows with `queued_at`,
 * which the backlog drain picks up; nothing depends on the message surviving.
 */
export async function ingestPollResult(
  env: IngestEnv,
  source: SourceRow,
  result: PollResult,
  filter: FilterConfig,
  now: number,
  ingestMode: IngestMode = "live",
  deferExtraction = false,
): Promise<{ itemsNew: number; enqueued: number }> {
  const platform = source.type;
  const known = await getItemStates(env.DB, platform, result.items.map((item) => item.externalId));
  const authorIds = new Map<string, number>();
  const statements: D1PreparedStatement[] = [];
  const wakeups: string[] = [];
  const since = await extractionWindowStart(env.DB, now);
  let itemsNew = 0;

  for (const item of result.items) {
    const contentHash = await sha256Hex(item.text);
    const existing = known.get(item.externalId);
    if (existing && existing.content_hash === contentHash) continue;

    let authorId: number | null = null;
    if (item.author) {
      const authorRef = `${item.author.platform}:${item.author.handle.toLowerCase()}`;
      authorId = authorIds.get(authorRef) ?? (await upsertAuthorByHandle(env.DB, { ...item.author, authorKey: source.author_key }));
      authorIds.set(authorRef, authorId);
    }

    // R2 is written only for new or changed content: rewriting every item on
    // every poll would cost over a million Class A operations a month.
    const key = rawKey(platform, item.publishedAt, await sha256Hex(item.externalId));
    await env.RAW.put(key, JSON.stringify({ text: item.text, raw: item.raw }), { httpMetadata: { contentType: "application/json" } });

    const decision = cheapFilter(item, source, filter);
    const canReopen = existing && (existing.filter_reason === "summary_only" ||
      (existing.status === "filtered_out" && (existing.filter_reason === "too_short" || existing.filter_reason === "no_topic_match")));
    const enriched = platform === "rss" && item.summaryOnly === false && decision.pass && canReopen;
    const write = upsertItemStatement(env.DB, {
      sourceId: source.id, platform, externalId: item.externalId, url: item.url, canonicalUrl: item.canonicalUrl,
      authorId, title: item.title, textExcerpt: item.text.slice(0, TEXT_EXCERPT_MAX), lang: item.lang, kind: item.kind,
      parentExternalId: item.parentExternalId, publishedAt: item.publishedAt, fetchedAt: now, rawR2Key: key, contentHash,
      topicHint: decision.pass ? decision.topicHint : source.topic_hint, ingestMode,
      status: decision.pass ? "queued" : "filtered_out",
      filterReason: decision.pass ? (item.summaryOnly ? "summary_only" : null) : decision.reason,
    });
    if (enriched) {
      // Keep the new AI decision and its input in the same transaction, even at a chunk boundary.
      await env.DB.batch([env.DB.prepare(`UPDATE items SET status = 'queued', filter_reason = NULL, queued_at = ?,
        enqueue_attempts = 0, editorial_attempts = 0, claims_returned = NULL, claims_accepted = NULL
        WHERE id = ? AND filter_reason = ? AND content_hash = ?`).bind(now, existing.id, existing.filter_reason, existing.content_hash), write]);
    } else {
      statements.push(write);
    }
    statements.push(...insertItemLinks(env.DB, platform, item.externalId, item.links));
    if (!existing) itemsNew++;
    if (!existing || enriched) {
      // Historical live items stay in D1 for a later drain. A source's first poll
      // must not spend the AI budget on its archive before other sources arrive.
      if (decision.pass && (ingestMode === "backfill" || item.publishedAt >= since)) wakeups.push(item.externalId);
    }
  }
  for (const metrics of result.metrics) statements.push(insertMetricSnapshot(env.DB, platform, { ...metrics, capturedAt: now }));
  for (const item of result.items) if (item.repository) statements.push(env.DB.prepare(`INSERT INTO repository_snapshots (item_id, captured_at, data_json)
    SELECT id, ?, ? FROM items WHERE platform = ? AND external_id = ? ON CONFLICT(item_id, captured_at) DO NOTHING`)
    .bind(now, JSON.stringify(item.repository), platform, item.externalId));
  await chunkedBatch(env.DB, statements);

  // Wake newly queued items, including a first upgrade from a teaser to the full article.
  const queued = await getItemStates(env.DB, platform, deferExtraction ? [] : wakeups);
  const messages = [...queued.values()]
    .filter((state) => state.status === "queued")
    .map((state) => ({ body: { kind: "extract", itemId: state.id, ...(ingestMode === "backfill" ? { backfill: true } : {}) } satisfies LlmMessage }));
  for (let start = 0; start < messages.length; start += SEND_BATCH_SIZE) {
    await env.LLM_QUEUE.sendBatch(messages.slice(start, start + SEND_BATCH_SIZE));
  }
  return { itemsNew, enqueued: messages.length };
}

/**
 * Polls one source. A failure of the source itself (blocked, rate limited, changed
 * payload) is recorded in the ledger and schedules its own retry. A failure while
 * storing the result is an infrastructure problem and is thrown, so the source's
 * health is not blamed for it and the queue retries the message.
 */
export async function pollSource(env: IngestEnv, sourceId: number, deps: IngestDeps = {}): Promise<void> {
  const now = deps.now ?? Math.floor(Date.now() / 1000);
  const source = await getSource(env.DB, sourceId);
  if (!source || source.enabled !== 1) {
    if (deps.crawl) await finishCrawlSource(env.DB, deps.crawl.id, sourceId, deps.crawl.token, now, 0, "source disabled");
    return;
  }
  const started = Date.now();
  const finishedAt = () => now + Math.floor((Date.now() - started) / 1000);
  const { ctx, filter } = await buildAdapterContext(env, now, deps.fetcher);

  let result: PollResult;
  try {
    result = await (deps.adapters?.[source.type] ?? ADAPTERS[source.type]).poll(source, ctx);
  } catch (err) {
    const http = err instanceof HttpError ? err : null;
    const message = http ? `${http.kind}:${http.reason}` : err instanceof Error ? `${err.name}: ${err.message}`.slice(0, 300) : "unknown_error";
    const failures = ((await getSourceHealth(env.DB, source.id))?.consecutive_failures ?? 0) + 1;
    await env.DB.batch([
      recordPollError(env.DB, source.id, now, message),
      insertPollLog(env.DB, { sourceId: source.id, at: now, status: "error", httpStatus: http?.status ?? null, durationMs: Date.now() - started, error: message }),
      scheduleNextPoll(env.DB, source.id, nextPollAt(now, source.poll_interval_min, failures)),
    ]);
    if (deps.crawl) await finishCrawlSource(env.DB, deps.crawl.id, source.id, deps.crawl.token, finishedAt(), 0, message);
    return;
  }

  const { itemsNew } = await ingestPollResult(env, source, result, filter, now, "live", Boolean(deps.crawl));
  if (deps.crawl) await recordCrawlItems(env.DB, source, result, deps.crawl.id, deps.crawl.token, now);
  await env.DB.batch([
    recordPollOk(env.DB, source.id, now, itemsNew),
    insertPollLog(env.DB, { sourceId: source.id, at: now, status: "ok", httpStatus: 200, itemsNew, durationMs: Date.now() - started }),
    scheduleNextPoll(env.DB, source.id, nextPollAt(now, source.poll_interval_min, 0)),
  ]);
  if (deps.crawl) await finishCrawlSource(env.DB, deps.crawl.id, source.id, deps.crawl.token, finishedAt(), itemsNew, null);
}

/** `radar-poll` consumer: one source per message, each acknowledged on its own. */
export async function consumePollBatch(batch: MessageBatch<PollMessage>, env: IngestEnv, deps: IngestDeps = {}): Promise<void> {
  for (const message of batch.messages) {
    let crawl: IngestDeps["crawl"];
    try {
      if (message.body.crawlId !== undefined) {
        const token = await claimCrawlSource(env.DB, message.body.crawlId, message.body.sourceId, deps.now ?? Math.floor(Date.now() / 1000));
        if (!token) { message.ack(); continue; }
        crawl = { id: message.body.crawlId, token };
      }
      await pollSource(env, message.body.sourceId, { ...deps, ...(crawl ? { crawl } : {}) });
      message.ack();
    } catch (err) {
      // Only infrastructure failures (D1, R2, queue) reach here; the queue retries them.
      console.error(JSON.stringify({ event: "poll_failed", sourceId: message.body.sourceId, error: String(err) }));
      if (crawl) await env.DB.prepare("UPDATE crawl_sources SET status = 'queued', lease_until = 0 WHERE crawl_id = ? AND source_id = ? AND token = ? AND status = 'running'").bind(crawl.id, message.body.sourceId, crawl.token).run();
      message.retry({ delaySeconds: 60 });
    }
  }
}
