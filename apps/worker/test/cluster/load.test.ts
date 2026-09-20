import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { chunkedBatch } from "../../src/db/batch";
import { runClusterJob } from "../../src/cluster/run-cluster-job";
import { fakeEmbedder, fakeLlmQueue, wipeClusterState } from "./seed-claims";

const T0 = Date.UTC(2026, 8, 20, 12, 5, 0) / 1000;
const TOTAL = 3500;

/** 300-claim burst, 40 stories of five claims, the rest isolated: the shape of a busy week. */
function tagFor(n: number): string {
  if (n < 300) return "S1";
  if (n < 500) return `S${2 + Math.floor((n - 300) / 5)}`;
  return `ISO${n}`;
}

describe("cluster job under load", () => {
  it("clusters 3,500 claims with a 300-claim burst within the edge and time budget", async () => {
    await wipeClusterState(env.DB);
    const db = env.DB;
    const source = await db.prepare("INSERT INTO sources (type, key, label) VALUES ('x', 'load-test', 'load') RETURNING id").first<{ id: number }>();
    await chunkedBatch(db, Array.from({ length: TOTAL }, (_, n) => db.prepare("INSERT INTO authors (author_key, canonical_name) VALUES (?1, ?1)").bind(`load-author-${n}`)));
    const firstAuthor = (await db.prepare("SELECT MIN(id) AS id FROM authors WHERE author_key LIKE 'load-author-%'").first<{ id: number }>())!.id;
    await chunkedBatch(db, Array.from({ length: TOTAL }, (_, n) =>
      db.prepare("INSERT INTO items (source_id, platform, external_id, url, canonical_url, author_id, text_excerpt, kind, published_at, fetched_at, content_hash, status) VALUES (?, 'x', ?, ?, ?, ?, 'load', 'post', ?, ?, 'h', 'extracted')")
        .bind(source!.id, `load-${n}`, `https://x.com/a/status/9${n}`, `https://x.com/a/status/9${n}`, firstAuthor + n, T0 - (n % 160) * 3600, T0)));
    const firstItem = (await db.prepare("SELECT MIN(id) AS id FROM items WHERE external_id LIKE 'load-%'").first<{ id: number }>())!.id;
    await chunkedBatch(db, Array.from({ length: TOTAL }, (_, n) =>
      db.prepare("INSERT INTO claims (item_id, author_id, kind, text_vi, text_en, quote, topics_json, published_at, content_hash, model, prompt_version, created_at) VALUES (?, ?, 'report', ?, ?, ?, '[\"ai\"]', ?, ?, 'test', 1, ?)")
        .bind(firstItem + n, firstAuthor + n, `Nhận định tải số ${n}.`, `${tagFor(n)} load claim ${n}`, `q${n}`, T0 - (n % 160) * 3600, `load-${n}`, T0)));

    const started = Date.now();
    const result = await runClusterJob({ DB: db, AI: env.AI, LLM_QUEUE: fakeLlmQueue().queue }, { now: T0, embed: fakeEmbedder().embed });
    const seconds = (Date.now() - started) / 1000;

    const counts = await db.prepare(
      `SELECT (SELECT COUNT(*) FROM claim_edges) AS cosine_edges, (SELECT edge_count FROM cluster_runs ORDER BY id DESC LIMIT 1) AS weighted_edges,
              (SELECT COUNT(*) FROM stories WHERE alive = 1) AS stories, (SELECT MAX(size) FROM run_communities) AS largest`,
    ).first<{ cosine_edges: number; weighted_edges: number; stories: number; largest: number }>();
    console.log("load:", JSON.stringify({ seconds: +seconds.toFixed(1), ...counts }));

    expect(result.status).toBe("done");
    expect(counts!.cosine_edges).toBeLessThanOrEqual(30 * TOTAL);
    // The burst holds together as one story and the forty small stories survive beside it.
    expect(counts!.largest).toBe(300);
    expect(counts!.stories).toBe(41);
    expect(seconds).toBeLessThan(60);
  }, 300_000);
});
