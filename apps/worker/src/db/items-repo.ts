import { sha256Hex } from "../util/hash";
import { chunkForParams, placeholders } from "./batch";
import type { SourceType } from "./sources-repo";

export type ItemKind = "post" | "reply" | "repost" | "quote" | "article" | "story" | "comment" | "release";
export type ItemStatus = "new" | "filtered_out" | "queued" | "extracted" | "irrelevant" | "failed";
export type IngestMode = "live" | "backfill";

export interface ItemRow {
  id: number;
  source_id: number;
  platform: SourceType;
  external_id: string;
  url: string;
  canonical_url: string;
  author_id: number | null;
  title: string | null;
  text_excerpt: string;
  lang: string | null;
  kind: ItemKind;
  parent_external_id: string | null;
  published_at: number;
  fetched_at: number;
  raw_r2_key: string | null;
  content_hash: string;
  status: ItemStatus;
  filter_reason: string | null;
  topic_hint: string | null;
  ingest_mode: IngestMode;
  queued_at: number | null;
  enqueue_attempts: number;
  claims_returned: number | null;
  claims_accepted: number | null;
}

export interface ItemInput {
  sourceId: number;
  platform: SourceType;
  externalId: string;
  url: string;
  canonicalUrl: string;
  authorId: number | null;
  title: string | null;
  textExcerpt: string;
  lang: string | null;
  kind: ItemKind;
  parentExternalId: string | null;
  publishedAt: number;
  fetchedAt: number;
  rawR2Key: string | null;
  contentHash: string;
  topicHint: string | null;
  ingestMode: IngestMode;
  /** Decided by the cheap filter before the insert, so the ledger row is complete in one statement. */
  status: "filtered_out" | "queued";
  filterReason: string | null;
}

export interface MetricSnapshotInput {
  externalId: string;
  capturedAt: number;
  likes?: number | null;
  reposts?: number | null;
  replies?: number | null;
  views?: number | null;
  bookmarks?: number | null;
  quotes?: number | null;
  points?: number | null;
  comments?: number | null;
}

/** External id for feed-based platforms: scoped to the source so feeds cannot collide. */
export async function feedExternalId(sourceId: number, guid: string): Promise<string> {
  return `${sourceId}:${await sha256Hex(guid)}`;
}

/**
 * Idempotent upsert. A new row is written together with its final state
 * (`queued` with `queued_at`, or `filtered_out`), so D1 is the ledger even if the
 * wake-up message is never sent. On conflict `url`, `source_id`, `published_at`,
 * `status` and `ingest_mode` keep their stored values: a re-poll may refresh
 * content but can neither move an item nor reopen work that was already done.
 */
export function upsertItemStatement(db: D1Database, item: ItemInput): D1PreparedStatement {
  const queued = item.status === "queued";
  return db
    .prepare(
      `INSERT INTO items (source_id, platform, external_id, url, canonical_url, author_id, title, text_excerpt, lang,
         kind, parent_external_id, published_at, fetched_at, raw_r2_key, content_hash, topic_hint, ingest_mode,
         status, filter_reason, queued_at, enqueue_attempts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(platform, external_id) DO UPDATE SET
         title = excluded.title,
         text_excerpt = excluded.text_excerpt,
         fetched_at = excluded.fetched_at,
         raw_r2_key = COALESCE(excluded.raw_r2_key, items.raw_r2_key),
         content_hash = excluded.content_hash,
         author_id = COALESCE(items.author_id, excluded.author_id)
       RETURNING id, status`,
    )
    .bind(
      item.sourceId, item.platform, item.externalId, item.url, item.canonicalUrl, item.authorId, item.title,
      item.textExcerpt, item.lang, item.kind, item.parentExternalId, item.publishedAt, item.fetchedAt,
      item.rawR2Key, item.contentHash, item.topicHint, item.ingestMode,
      item.status, item.filterReason, queued ? item.fetchedAt : null, queued ? 1 : 0,
    );
}

export async function upsertItem(db: D1Database, item: ItemInput): Promise<{ id: number; status: ItemStatus }> {
  const row = await upsertItemStatement(db, item).first<{ id: number; status: ItemStatus }>();
  if (!row) throw new Error(`could not upsert item ${item.platform}:${item.externalId}`);
  return row;
}

export interface ItemState {
  id: number;
  status: ItemStatus;
  content_hash: string;
}

/** Current state of the given external ids, keyed by external id. Unknown ids are absent. */
export async function getItemStates(db: D1Database, platform: SourceType, externalIds: readonly string[]): Promise<Map<string, ItemState>> {
  const states = new Map<string, ItemState>();
  for (const chunk of chunkForParams(externalIds, 1, 1)) {
    const { results } = await db
      .prepare(`SELECT id, external_id, status, content_hash FROM items WHERE platform = ? AND external_id IN (${placeholders(chunk.length)})`)
      .bind(platform, ...chunk)
      .all<ItemState & { external_id: string }>();
    for (const row of results) states.set(row.external_id, { id: row.id, status: row.status, content_hash: row.content_hash });
  }
  return states;
}

export function insertItemLinks(db: D1Database, platform: SourceType, externalId: string, canonicalUrls: readonly string[]): D1PreparedStatement[] {
  return [...new Set(canonicalUrls)].map((url) =>
    db
      .prepare(
        `INSERT INTO item_links (item_id, canonical_url) SELECT id, ?3 FROM items WHERE platform = ?1 AND external_id = ?2
         ON CONFLICT(item_id, canonical_url) DO NOTHING`,
      )
      .bind(platform, externalId, url),
  );
}

export function insertMetricSnapshot(db: D1Database, platform: SourceType, metrics: MetricSnapshotInput): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO item_metrics (item_id, captured_at, likes, reposts, replies, views, bookmarks, quotes, points, comments)
       SELECT id, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11 FROM items WHERE platform = ?1 AND external_id = ?2
       ON CONFLICT(item_id, captured_at) DO NOTHING`,
    )
    .bind(
      platform, metrics.externalId, metrics.capturedAt, metrics.likes ?? null, metrics.reposts ?? null, metrics.replies ?? null,
      metrics.views ?? null, metrics.bookmarks ?? null, metrics.quotes ?? null, metrics.points ?? null, metrics.comments ?? null,
    );
}

/** Records another wake-up message for an item that is still waiting. */
export function touchEnqueued(db: D1Database, itemId: number, at: number): D1PreparedStatement {
  return db.prepare("UPDATE items SET queued_at = ?, enqueue_attempts = enqueue_attempts + 1 WHERE id = ? AND status = 'queued'").bind(at, itemId);
}

export async function getItemsByIds(db: D1Database, ids: readonly number[]): Promise<ItemRow[]> {
  const rows: ItemRow[] = [];
  for (const chunk of chunkForParams(ids)) {
    const { results } = await db.prepare(`SELECT * FROM items WHERE id IN (${placeholders(chunk.length)})`).bind(...chunk).all<ItemRow>();
    rows.push(...results);
  }
  return rows;
}
