import { chunkedBatch } from "../db/batch";
import { getItemStates } from "../db/items-repo";
import type { SourceRow } from "../db/sources-repo";
import type { PollResult } from "../sources/source-adapter";
import { sha256Hex } from "../util/hash";
import type { RepositoryFacts } from "@radar/core";

export interface CrawlItemSnapshot {
  id: number; sourceId: number; sourceLabel: string; author: string | null; authorKey: string | null;
  platform: string; externalId: string; url: string; title: string | null; text: string;
  kind: string; publishedAt: number; capturedAt: number; contentHash: string;
  metrics: Record<string, number | string | null | undefined> | null;
  repository: RepositoryFacts | null;
}

/** Freeze source content and metrics for rebuilding a feed from this crawl later. */
export async function recordCrawlItems(db: D1Database, source: SourceRow, result: PollResult, crawlId: number, token: string, now: number): Promise<void> {
  const known = await getItemStates(db, source.type, result.items.map((item) => item.externalId));
  const metrics = new Map(result.metrics.map((entry) => [entry.externalId, entry]));
  const statements: D1PreparedStatement[] = [];
  for (const item of result.items) {
    const state = known.get(item.externalId);
    if (!state) continue;
    const snapshot: CrawlItemSnapshot = {
      id: state.id, sourceId: source.id, sourceLabel: source.label,
      author: item.author?.displayName ?? item.author?.handle ?? null, authorKey: source.author_key,
      platform: item.platform, externalId: item.externalId, url: item.url, title: item.title,
      text: item.text.slice(0, 6000), kind: item.kind, publishedAt: item.publishedAt, capturedAt: now,
      contentHash: await sha256Hex(item.text), metrics: metrics.has(item.externalId) ? { ...metrics.get(item.externalId)! } : null,
      repository: item.repository ?? null,
    };
    statements.push(db.prepare(`INSERT INTO crawl_items (crawl_id, item_id, snapshot_json)
      SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM crawl_sources cs JOIN crawl_runs r ON r.id = cs.crawl_id
        WHERE cs.crawl_id = ? AND cs.source_id = ? AND cs.token = ? AND cs.status = 'running' AND r.status = 'running')
      ON CONFLICT(crawl_id, item_id) DO UPDATE SET snapshot_json = excluded.snapshot_json`)
      .bind(crawlId, state.id, JSON.stringify(snapshot), crawlId, source.id, token));
  }
  await chunkedBatch(db, statements);
}
