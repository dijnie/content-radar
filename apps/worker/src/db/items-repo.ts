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
}

export interface MetricSnapshotInput {
  itemId: number;
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
 * Idempotent upsert. On conflict `url`, `source_id`, `published_at`, `status`
 * and `ingest_mode` keep their stored values: a re-poll may refresh content but
 * can neither move an item nor reopen work that was already done. An item
 * still needs processing exactly when the returned status is `new`.
 */
export async function upsertItem(db: D1Database, item: ItemInput): Promise<{ id: number; status: ItemStatus }> {
  const row = await db
    .prepare(
      `INSERT INTO items (source_id, platform, external_id, url, canonical_url, author_id, title, text_excerpt, lang,
         kind, parent_external_id, published_at, fetched_at, raw_r2_key, content_hash, topic_hint, ingest_mode)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(platform, external_id) DO UPDATE SET
         title = excluded.title,
         text_excerpt = excluded.text_excerpt,
         fetched_at = excluded.fetched_at,
         raw_r2_key = excluded.raw_r2_key,
         content_hash = excluded.content_hash,
         author_id = COALESCE(items.author_id, excluded.author_id)
       RETURNING id, status`,
    )
    .bind(
      item.sourceId, item.platform, item.externalId, item.url, item.canonicalUrl, item.authorId, item.title,
      item.textExcerpt, item.lang, item.kind, item.parentExternalId, item.publishedAt, item.fetchedAt,
      item.rawR2Key, item.contentHash, item.topicHint, item.ingestMode,
    )
    .first<{ id: number; status: ItemStatus }>();
  if (!row) throw new Error(`could not upsert item ${item.platform}:${item.externalId}`);
  return row;
}

export function insertItemLinks(db: D1Database, itemId: number, canonicalUrls: readonly string[]): D1PreparedStatement[] {
  return [...new Set(canonicalUrls)].map((url) =>
    db.prepare("INSERT INTO item_links (item_id, canonical_url) VALUES (?, ?) ON CONFLICT(item_id, canonical_url) DO NOTHING").bind(itemId, url),
  );
}

export function insertMetricSnapshot(db: D1Database, metrics: MetricSnapshotInput): D1PreparedStatement {
  return db
    .prepare(
      `INSERT OR REPLACE INTO item_metrics (item_id, captured_at, likes, reposts, replies, views, bookmarks, quotes, points, comments)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      metrics.itemId, metrics.capturedAt, metrics.likes ?? null, metrics.reposts ?? null, metrics.replies ?? null,
      metrics.views ?? null, metrics.bookmarks ?? null, metrics.quotes ?? null, metrics.points ?? null, metrics.comments ?? null,
    );
}

/** Moves an item out of `new`. Items already past `new` are left untouched. */
export function markFiltered(db: D1Database, itemId: number, reason: string): D1PreparedStatement {
  return db.prepare("UPDATE items SET status = 'filtered_out', filter_reason = ? WHERE id = ? AND status = 'new'").bind(reason, itemId);
}

export function markQueued(db: D1Database, itemId: number, at: number): D1PreparedStatement {
  return db
    .prepare("UPDATE items SET status = 'queued', queued_at = ?, enqueue_attempts = enqueue_attempts + 1 WHERE id = ? AND status = 'new'")
    .bind(at, itemId);
}

export async function getItemsByIds(db: D1Database, ids: readonly number[]): Promise<ItemRow[]> {
  const rows: ItemRow[] = [];
  for (const chunk of chunkForParams(ids)) {
    const { results } = await db.prepare(`SELECT * FROM items WHERE id IN (${placeholders(chunk.length)})`).bind(...chunk).all<ItemRow>();
    rows.push(...results);
  }
  return rows;
}
