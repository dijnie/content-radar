import type { EditorialEntry } from "@radar/core";
import type { FeedBuildContext } from "./build-feed";
import { evidence, feedItems, interactions, type FeedItem } from "./feed-items";
import { chunkForParams, placeholders } from "../db/batch";
import type { EditorialScoring } from "./editorial-scoring";

/** Stories supply existing ranking; crawl snapshots supply deduplicated, as-crawled source statistics. */
export async function* buildNews(context: FeedBuildContext, cutoff: number): AsyncGenerator<EditorialEntry[]> {
  const grouped = new Map<number, Map<number, FeedItem>>();
  for await (const items of feedItems(context.db, context.crawlId, cutoff)) {
    const byClaim = new Map(items.flatMap((item) => item.claims.map((claim) => [claim.id, item] as const)));
    for (const ids of chunkForParams([...byClaim.keys()])) {
      const memberships = await context.db.prepare(`SELECT sc.story_id, sc.claim_id FROM story_claims sc
        JOIN stories s ON s.id = sc.story_id WHERE sc.active = 1 AND s.alive = 1 AND sc.claim_id IN (${placeholders(ids.length)})`)
        .bind(...ids).all<{ story_id: number; claim_id: number }>();
      for (const row of memberships.results) {
        const item = byClaim.get(row.claim_id)!;
        const members = grouped.get(row.story_id) ?? new Map<number, FeedItem>();
        const member = members.get(item.snapshot.id) ?? { ...item, claims: [] };
        member.claims.push(item.claims.find((claim) => claim.id === row.claim_id)!);
        members.set(item.snapshot.id, member);
        grouped.set(row.story_id, members);
      }
    }
  }
  context.metadata.candidates = grouped.size;
  for (const ids of chunkForParams([...grouped.keys()])) {
    const rows = await context.db.prepare(`SELECT id, headline_vi, score, questions_json FROM stories WHERE id IN (${placeholders(ids.length)})`).bind(...ids)
      .all<{ id: number; headline_vi: string; score: number; questions_json: string }>();
    yield rows.results.map((story) => {
      const items = [...grouped.get(story.id)!.values()];
      const voices = new Set(items.flatMap(({ snapshot: s }) => s.authorKey ? [s.authorKey] : s.author ? [`${s.platform}:${s.author}`] : []));
      const counts = items.map(({ snapshot }) => interactions(snapshot)).filter((n): n is number => n !== null);
      const questions = JSON.parse(story.questions_json) as string[];
      const leaders = (context.metadata.scoring as EditorialScoring).labLeaderAuthorKeys;
      return {
        key: `story:${story.id}`, category: "news", pillar: "other", title: story.headline_vi, summary: "",
        question: questions[0] ?? null, findings: items.flatMap((item) => item.claims.map((c) => c.text)).slice(0, 12),
        score: story.score, publishedAt: Math.max(...items.map((item) => item.snapshot.publishedAt)),
        sources: items.map(evidence), voices: voices.size,
        labLeaders: leaders.length ? new Set(items.map((item) => item.snapshot.authorKey).filter((key): key is string => key !== null && leaders.includes(key))).size : null,
        interactions: counts.length ? counts.reduce((a, b) => a + b, 0) : null,
        platforms: new Set(items.map((item) => item.snapshot.platform)).size,
        articles: new Set(items.filter((item) => item.snapshot.kind === "article").map((item) => item.snapshot.url)).size,
        repository: null, scoreParts: {}, read: false,
      } satisfies EditorialEntry;
    });
  }
}
