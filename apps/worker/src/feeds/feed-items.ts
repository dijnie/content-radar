import type { EditorialEntry, SourceEvidence } from "@radar/core";
import type { CrawlItemSnapshot } from "../jobs/crawl-snapshots";
import { quoteFoundIn } from "../llm/extract/quote-match";

export interface FeedClaim { id: number; text: string; quote: string; kind: string; firstHand: number; score: number | null }
export interface FeedItem {
  snapshot: CrawlItemSnapshot;
  editorial: { category: string; pillar: string; summary: string; question: string | null } | null;
  claims: FeedClaim[];
}

/** The selected crawl is a cutoff. Earlier successful crawls supply the longer reading windows. */
export async function* feedItems(db: D1Database, crawlId: number, cutoff: number): AsyncGenerator<FeedItem[]> {
  let after = 0;
  for (;;) {
    const rows = await db.prepare(`SELECT ci.item_id, ci.snapshot_json,
      CASE WHEN e.item_id IS NOT NULL THEN json_object('category', e.category, 'pillar', e.pillar, 'summary', e.summary_vi, 'question', e.question_vi) END AS editorial_json,
      (SELECT json_group_array(json_object('id', c.id, 'text', c.text_vi, 'quote', c.quote, 'kind', c.kind, 'firstHand', c.first_hand,
        'score', (SELECT MAX(s.score) FROM story_claims sc JOIN stories s ON s.id = sc.story_id WHERE sc.claim_id = c.id AND sc.active = 1))) FROM claims c WHERE c.item_id = ci.item_id) AS claims_json
      FROM crawl_items ci JOIN items i ON i.id = ci.item_id
      LEFT JOIN item_editorial e ON e.item_id = ci.item_id AND e.content_hash = json_extract(ci.snapshot_json, '$.contentHash')
      WHERE ci.item_id > ? AND ci.crawl_id = (SELECT MAX(prior.crawl_id) FROM crawl_items prior
        JOIN crawl_runs r ON r.id = prior.crawl_id
        JOIN crawl_sources cs ON cs.crawl_id = prior.crawl_id AND cs.source_id = json_extract(prior.snapshot_json, '$.sourceId')
        WHERE prior.item_id = ci.item_id AND prior.crawl_id <= ? AND r.status IN ('ok', 'partial') AND cs.status = 'ok')
        AND json_extract(ci.snapshot_json, '$.publishedAt') >= ?
        AND (i.content_hash != json_extract(ci.snapshot_json, '$.contentHash') OR i.status NOT IN ('filtered_out', 'irrelevant'))
      ORDER BY ci.item_id LIMIT 50`).bind(after, crawlId, cutoff).all<{ item_id: number; snapshot_json: string; editorial_json: string | null; claims_json: string }>();
    if (!rows.results.length) return;
    after = rows.results.at(-1)!.item_id;
    yield rows.results.map((row) => {
      const snapshot = JSON.parse(row.snapshot_json) as CrawlItemSnapshot;
      const claims = (JSON.parse(row.claims_json) as FeedClaim[]).filter((claim) => quoteFoundIn(claim.quote, snapshot.text));
      return { snapshot, editorial: row.editorial_json ? JSON.parse(row.editorial_json) as FeedItem["editorial"] : null, claims };
    });
  }
}

export function evidence(item: FeedItem): SourceEvidence {
  const s = item.snapshot;
  return { itemId: s.id, url: s.url, title: s.title ?? s.text.slice(0, 100), source: s.sourceLabel,
    author: s.author, platform: s.platform, publishedAt: s.publishedAt,
    ...(item.claims[0] ? { quote: item.claims[0].quote } : {}),
    upvotes: typeof s.metrics?.points === "number" ? s.metrics.points : null,
    comments: typeof s.metrics?.comments === "number" ? s.metrics.comments : null };
}

export function interactions(snapshot: CrawlItemSnapshot): number | null {
  if (!snapshot.metrics || snapshot.platform === "github") return null;
  const values = ["likes", "reposts", "replies", "quotes", "points", "comments"].map((name) => snapshot.metrics?.[name]).filter((n): n is number => typeof n === "number");
  return values.length ? values.reduce((sum, n) => sum + Math.max(0, n), 0) : null;
}

export function baseEntry(item: FeedItem, category: EditorialEntry["category"]): EditorialEntry {
  const { snapshot: s, editorial: e, claims } = item;
  return {
    key: `item:${s.id}`, category, pillar: e?.pillar ?? "other", title: s.title ?? claims[0]?.text ?? s.text.slice(0, 140),
    summary: e?.summary ?? claims.map((claim) => claim.text).join(" "), question: e?.question ?? null,
    findings: claims.slice(0, 6).map((claim) => claim.text), score: Math.max(0, ...claims.map((claim) => claim.score ?? 0)),
    publishedAt: s.publishedAt, sources: [evidence(item)], voices: s.author ? 1 : 0, labLeaders: null,
    interactions: interactions(s), platforms: 1, articles: s.kind === "article" ? 1 : 0,
    repository: s.repository ?? null, scoreParts: {}, read: false,
  };
}
