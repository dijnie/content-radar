import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { buildFeedEntries } from "../../src/feeds/build-feed";
import type { EditorialEntry, FeedKind, RepositoryFacts } from "@radar/core";
import type { CrawlItemSnapshot } from "../../src/jobs/crawl-snapshots";
import { upsertItem } from "../../src/db/items-repo";
import { itemInput, seedSource } from "../db/seed";
import settings from "../../../../config/settings.json";
import { scoreRepository } from "../../src/feeds/editorial-scoring";

const NOW = 1790000000;
let sequence = 0;
let crawlId: number;
let sourceId: number;
const text = "The researchers measured a 20% reduction in latency on their own benchmark.";

beforeEach(async () => {
  sourceId = await seedSource(env.DB, "rss", `editorial-${++sequence}`);
  crawlId = (await env.DB.prepare("INSERT INTO crawl_runs (trigger, status, started_at, finished_at) VALUES ('manual', 'ok', ?, ?) RETURNING id").bind(NOW, NOW).first<{ id: number }>())!.id;
  await env.DB.batch([
    env.DB.prepare("INSERT INTO crawl_sources (crawl_id, source_id, status) VALUES (?, ?, 'ok')").bind(crawlId, sourceId),
    env.DB.prepare("INSERT INTO settings (key, value_json) VALUES ('editorial_scoring', ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json").bind(JSON.stringify(settings.editorial_scoring)),
  ]);
});

async function item(category: string, repository: RepositoryFacts | null = null) {
  const row = await upsertItem(env.DB, itemInput({ sourceId, platform: "rss", externalId: `entry-${sequence}-${category}`, kind: "article", title: `Paper ${sequence}`, textExcerpt: text, contentHash: `hash-${sequence}`, publishedAt: NOW, fetchedAt: NOW }));
  const snapshot: CrawlItemSnapshot = { id: row.id, sourceId, sourceLabel: "Papers", author: "Research team", authorKey: null, platform: "rss", externalId: `entry-${sequence}-${category}`, url: `https://example.com/${row.id}`, title: `Paper ${sequence}`, text, kind: "article", publishedAt: NOW, capturedAt: NOW, contentHash: `hash-${sequence}`, metrics: { points: 12, comments: 2 }, repository };
  await env.DB.batch([
    env.DB.prepare("INSERT INTO crawl_items (crawl_id, item_id, snapshot_json) VALUES (?, ?, ?)").bind(crawlId, row.id, JSON.stringify(snapshot)),
    env.DB.prepare("INSERT INTO item_editorial (item_id, content_hash, category, pillar, summary_vi, question_vi, model, updated_at) VALUES (?, ?, ?, 'architecture', 'Một bản tóm tắt có nguồn.', 'Bộ thử nào được dùng?', 'deepseek-flash', ?)").bind(row.id, snapshot.contentHash, category, NOW),
    env.DB.prepare(`INSERT INTO claims (item_id, kind, text_vi, text_en, quote, first_hand, published_at, content_hash, model, prompt_version, created_at)
      VALUES (?, 'measurement', 'Độ trễ giảm 20% trong thử nghiệm.', ?, ?, 1, ?, ?, 'deepseek-flash', 3, ?)`)
      .bind(row.id, text, text, NOW, `claim-${row.id}`, NOW),
  ]);
  return row.id;
}
async function build(feed: FeedKind) {
  const entries: EditorialEntry[] = [];
  for await (const page of buildFeedEntries({ db: env.DB, feed, crawlId, now: NOW, metadata: {} })) entries.push(...page);
  return entries;
}

describe("editorial feed builders use persisted evidence", () => {
  it("classifies deep dives and field tests with original links, verified findings and real metrics", async () => {
    const paper = await item("deep_dive");
    const test = await item("field_test");
    expect((await build("deep-dives")).find((entry) => entry.key === `item:${paper}`)).toMatchObject({ question: "Bộ thử nào được dùng?", findings: ["Độ trễ giảm 20% trong thử nghiệm."], interactions: 14, sources: [{ itemId: paper, upvotes: 12, comments: 2 }] });
    expect((await build("hands-on")).find((entry) => entry.key === `item:${test}`)?.category).toBe("field-tests");
  });
  it("counts a source once per News story and keeps findings in their own story", async () => {
    const id = await item("news");
    const first = (await env.DB.prepare("SELECT id FROM claims WHERE item_id = ?").bind(id).first<{ id: number }>())!.id;
    const second = (await env.DB.prepare(`INSERT INTO claims (item_id, kind, text_vi, text_en, quote, first_hand, published_at, content_hash, model, prompt_version, created_at)
      VALUES (?, 'measurement', 'Một kết quả khác trong cùng bài.', ?, ?, 1, ?, ?, 'deepseek-flash', 3, ?) RETURNING id`)
      .bind(id, text, text, NOW, `other-${id}`, NOW).first<{ id: number }>())!.id;
    const cluster = (await env.DB.prepare("INSERT INTO cluster_runs (started_at, heartbeat_at, status, params_json, seed) VALUES (?, ?, 'done', '{}', 42) RETURNING id").bind(NOW, NOW).first<{ id: number }>())!.id;
    const stories: number[] = [];
    for (const score of [72, 40]) {
      const story = (await env.DB.prepare("INSERT INTO stories (headline_vi, score, first_seen_at, last_claim_at, members_hash) VALUES ('A measured result', ?, ?, ?, 'hash') RETURNING id").bind(score, NOW, NOW).first<{ id: number }>())!.id;
      stories.push(story);
    }
    await env.DB.batch([
      env.DB.prepare("INSERT INTO story_claims (story_id, claim_id, added_run_id) VALUES (?, ?, ?)").bind(stories[0], first, cluster),
      env.DB.prepare("INSERT INTO story_claims (story_id, claim_id, added_run_id) VALUES (?, ?, ?)").bind(stories[0], second, cluster),
      env.DB.prepare("INSERT INTO story_claims (story_id, claim_id, added_run_id) VALUES (?, ?, ?)").bind(stories[1], second, cluster),
    ]);
    const entries = await build("news");
    expect(entries.find((entry) => entry.key === `story:${stories[0]}`)).toMatchObject({ interactions: 14, voices: 1, articles: 1, platforms: 1, score: 72 });
    expect(entries.find((entry) => entry.key === `story:${stories[0]}`)!.sources).toHaveLength(1);
    expect(entries.find((entry) => entry.key === `story:${stories[1]}`)!.findings).toEqual(["Một kết quả khác trong cùng bài."]);
  });

  it("uses the selected crawl's repository facts even after the live item changes", async () => {
    const facts: RepositoryFacts = { fullName: "example/repo", stars: 1000, starsToday: 40, trendingRank: 3, forks: 50, pushedAt: NOW - 86400, archived: false, license: "MIT", capturedAt: NOW };
    const id = await item("tool", facts);
    await env.DB.prepare("UPDATE items SET title = 'Changed later', content_hash = 'new-version' WHERE id = ?").bind(id).run();
    const entry = (await build("hands-on")).find((entry) => entry.key === "repo:example/repo")!;
    expect(entry.title).toBe("example/repo");
    expect(entry.repository).toEqual(facts);
    expect(entry.score).toBe(scoreRepository(facts, settings.editorial_scoring).score);
  });
  it("never counts an unmeasured field-test category without a first-hand claim", async () => {
    const id = await item("field_test");
    await env.DB.prepare("UPDATE claims SET first_hand = 0 WHERE item_id = ?").bind(id).run();
    expect((await build("hands-on")).some((entry) => entry.key === `item:${id}`)).toBe(false);
  });
  it("retains measured trending rank when a later search observes the same repository that day", async () => {
    const facts: RepositoryFacts = { fullName: "example/trending", stars: 1000, starsToday: 40, trendingRank: 3, forks: 50, pushedAt: NOW - 86400, archived: false, license: "MIT", capturedAt: NOW };
    await item("tool", facts);
    await item("other", { ...facts, capturedAt: NOW + 1, starsToday: null, trendingRank: null });
    const entries = (await build("hands-on")).filter((entry) => entry.key === "repo:example/trending");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.repository).toEqual(facts);
  });

  it("keeps missing repository signals null without redistributing their weight", () => {
    const result = scoreRepository({ fullName: "example/repo", stars: 100000, starsToday: null, trendingRank: null, forks: null, pushedAt: null, archived: null, license: null, capturedAt: NOW }, settings.editorial_scoring);
    expect(result.score).toBe(20);
    expect(result.parts.starsToday).toBeNull();
    expect(result.parts.health).toBeNull();
  });
});
