import type { EditorialEntry, FeedKind } from "@radar/core";
import { getSetting } from "../db/settings-repo";
import { buildNews } from "./build-news";
import { baseEntry, feedItems } from "./feed-items";
import { editorialScoringSchema, scoreRepository } from "./editorial-scoring";

export interface FeedBuildContext {
  db: D1Database; feed: FeedKind; crawlId: number; now: number; metadata: Record<string, unknown>;
}

export async function* buildFeedEntries(context: FeedBuildContext): AsyncGenerator<EditorialEntry[]> {
  const { db, feed, crawlId, metadata } = context;
  const crawl = await db.prepare("SELECT finished_at FROM crawl_runs WHERE id = ? AND status IN ('ok', 'partial')").bind(crawlId).first<{ finished_at: number }>();
  if (!crawl) throw new Error("completed_crawl_required");
  const scoring = editorialScoringSchema.parse(await getSetting(db, "editorial_scoring"));
  metadata.scoring = scoring;
  metadata.threshold = feed === "news" ? scoring.newsMinScore : null;
  metadata.crawlFinishedAt = crawl.finished_at;
  if (feed === "news") {
    for await (const entries of buildNews(context, crawl.finished_at - 7 * 86400)) {
      yield entries;
    }
    return;
  }
  let awaitingEditorial = 0;
  // The map collapses repositories seen both through search and the real Trending source.
  const repos = new Map<string, EditorialEntry>();
  for await (const items of feedItems(db, crawlId, crawl.finished_at - (feed === "hands-on" ? 30 : 90) * 86400)) {
    const entries: EditorialEntry[] = [];
    for (const item of items) {
      if (feed === "hands-on" && item.snapshot.repository) {
        const entry = baseEntry(item, "toolbox");
        const repo = item.snapshot.repository;
        const score = scoreRepository(repo, scoring);
        entry.key = `repo:${repo.fullName.toLowerCase()}`;
        entry.title = repo.fullName;
        entry.summary ||= item.snapshot.text.split("\n").slice(1).join("\n");
        entry.score = score.score;
        entry.scoreParts = score.parts;
        entry.publishedAt = repo.capturedAt;
        const previous = repos.get(entry.key);
        // A search response cannot replace measured Trending facts from the same UTC day.
        const previousFacts = previous?.repository;
        const sameDay = previousFacts && Math.floor(repo.capturedAt / 86400) === Math.floor(previousFacts.capturedAt / 86400);
        const preferTrending = sameDay && (repo.trendingRank !== null) !== (previousFacts.trendingRank !== null);
        if (!previousFacts || (preferTrending ? repo.trendingRank !== null : repo.capturedAt > previousFacts.capturedAt)) repos.set(entry.key, entry);
        continue;
      }
      if (!item.editorial) { awaitingEditorial++; continue; }
      const category = item.editorial.category;
      if (feed === "deep-dives" && category === "deep_dive") entries.push(baseEntry(item, "deep-dives"));
      if (feed === "hands-on") {
        if (category === "field_test" && item.claims.some((claim) => claim.firstHand && ["measurement", "experience"].includes(claim.kind))) entries.push(baseEntry(item, "field-tests"));
        if (category === "playbook") entries.push(baseEntry(item, "playbooks"));
        if (category === "tool") entries.push(baseEntry(item, "toolbox"));
      }
    }
    yield entries;
  }
  if (repos.size) yield [...repos.values()];
  metadata.awaitingEditorial = awaitingEditorial;
}
