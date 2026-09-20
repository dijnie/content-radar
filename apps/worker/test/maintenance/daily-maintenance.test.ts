import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { runDailyMaintenance } from "../../src/maintenance/run-daily-maintenance";
import { seedClaims, wipeClusterState } from "../cluster/seed-claims";

const DAY = 86_400;
const NOW = Date.UTC(2026, 8, 20, 8, 20, 0) / 1000;
const db = () => env.DB;
const scalar = async (sql: string, ...binds: unknown[]) => Object.values((await db().prepare(sql).bind(...binds).first<Record<string, number>>())!)[0];

beforeEach(async () => {
  await wipeClusterState(db());
  await db().batch([db().prepare("DELETE FROM author_baselines"), db().prepare("DELETE FROM poll_log"), db().prepare("DELETE FROM llm_calls")]);
});

describe("author baselines", () => {
  it("uses the latest snapshot of up to 50 matured posts and is robust to a viral outlier", async () => {
    const source = await db().prepare("INSERT INTO sources (type, key, label) VALUES ('x', ?, 'b') RETURNING id").bind(`baseline-${NOW}`).first<{ id: number }>();
    const author = await db().prepare("INSERT INTO authors (author_key, canonical_name) VALUES ('baseline-author', 'B') ON CONFLICT(author_key) DO UPDATE SET canonical_name = 'B' RETURNING id").first<{ id: number }>();
    const likes = [100, 110, 90, 105, 95, 100, 98, 102, 101, 99, 250_000];
    for (const [n, value] of likes.entries()) {
      const item = await db()
        .prepare("INSERT INTO items (source_id, platform, external_id, url, canonical_url, author_id, kind, published_at, fetched_at, content_hash, status) VALUES (?, 'x', ?, 'u', 'u', ?, 'post', ?, ?, 'h', 'extracted') RETURNING id")
        .bind(source!.id, `baseline-${n}`, author!.id, NOW - (n + 2) * DAY, NOW)
        .first<{ id: number }>();
      await db().batch([
        db().prepare("INSERT INTO item_metrics (item_id, captured_at, likes) VALUES (?, ?, 1)").bind(item!.id, NOW - DAY),
        db().prepare("INSERT INTO item_metrics (item_id, captured_at, likes) VALUES (?, ?, ?)").bind(item!.id, NOW - 3600, value),
      ]);
    }
    // Too young to have matured: must not enter the baseline.
    const young = await db().prepare("INSERT INTO items (source_id, platform, external_id, url, canonical_url, author_id, kind, published_at, fetched_at, content_hash, status) VALUES (?, 'x', 'baseline-young', 'u', 'u', ?, 'post', ?, ?, 'h', 'extracted') RETURNING id").bind(source!.id, author!.id, NOW - 3600, NOW).first<{ id: number }>();
    await db().prepare("INSERT INTO item_metrics (item_id, captured_at, likes) VALUES (?, ?, 999999)").bind(young!.id, NOW - 60).run();

    await runDailyMaintenance(db(), NOW);
    expect(await db().prepare("SELECT median, mad, sample_size FROM author_baselines WHERE author_id = ?").bind(author!.id).first()).toEqual({ median: 100, mad: 2, sample_size: 11 });
  });
});

describe("daily aggregates", () => {
  it("files claims under the day they were published, so a backfill fills in history", async () => {
    const claimIds = await seedClaims(db(), [
      { tag: "S1", publishedAt: NOW - 5 * DAY, entity: "Orion" }, { tag: "S1", publishedAt: NOW - 5 * DAY + 60, entity: "Orion" }, { tag: "S1", publishedAt: NOW - 3600, entity: "Orion" },
    ]);
    const story = await db().prepare("INSERT INTO stories (headline_vi, score, first_seen_at, last_claim_at, members_hash, alive) VALUES ('h', 55, ?, ?, 'x', 1) RETURNING id").bind(NOW, NOW).first<{ id: number }>();
    const run = await db().prepare("INSERT INTO cluster_runs (started_at, heartbeat_at, status, params_json, seed) VALUES (?, ?, 'done', '{}', 42) RETURNING id").bind(NOW, NOW).first<{ id: number }>();
    const entity = await db().prepare("INSERT INTO entities (canonical_name, type, created_at) VALUES ('Orion', 'product', ?) RETURNING id").bind(NOW).first<{ id: number }>();
    await db().batch([
      ...claimIds.map((id) => db().prepare("INSERT INTO story_claims (story_id, claim_id, added_run_id) VALUES (?, ?, ?)").bind(story!.id, id, run!.id)),
      db().prepare("UPDATE entity_mentions SET entity_id = ?").bind(entity!.id),
    ]);

    await runDailyMaintenance(db(), NOW);
    await runDailyMaintenance(db(), NOW);
    const days = (await db().prepare("SELECT day, claim_count, source_count, score FROM story_daily WHERE story_id = ? ORDER BY day").bind(story!.id).all()).results;
    expect(days).toEqual([{ day: "2026-09-15", claim_count: 2, source_count: 2, score: null }, { day: "2026-09-20", claim_count: 1, source_count: 1, score: 55 }]);
    expect((await db().prepare("SELECT day, claim_count, author_count FROM entity_daily WHERE entity_id = ? ORDER BY day").bind(entity!.id).all()).results).toEqual([
      { day: "2026-09-15", claim_count: 2, author_count: 2 }, { day: "2026-09-20", claim_count: 1, author_count: 1 },
    ]);
  });
});

describe("retention and repair", () => {
  it("trims logs and old snapshots, compacts old metrics to one per day, and fails runs whose lease is gone", async () => {
    const [claimId] = await seedClaims(db(), [{ tag: "S1", publishedAt: NOW - DAY }]);
    const item = (await db().prepare("SELECT item_id FROM claims WHERE id = ?").bind(claimId).first<{ item_id: number }>())!.item_id;
    const story = await db().prepare("INSERT INTO stories (headline_vi, first_seen_at, last_claim_at, members_hash, alive) VALUES ('h', ?, ?, 'x', 1) RETURNING id").bind(NOW, NOW).first<{ id: number }>();
    const run = (at: number, status: string) => db().prepare("INSERT INTO cluster_runs (started_at, heartbeat_at, status, params_json, seed) VALUES (?, ?, ?, '{}', 42) RETURNING id").bind(at, at, status).first<{ id: number }>();
    const oldRun = await run(NOW - 20 * DAY, "done");
    const recentRun = await run(NOW - DAY, "done");
    const hungRun = await run(NOW - 3 * 3600, "running");
    const oldDay = NOW - 20 * DAY;
    await db().batch([
      ...[oldRun, recentRun].flatMap((r) => [
        db().prepare("INSERT INTO run_communities (run_id, community_idx, story_id, size, members_hash) VALUES (?, 0, ?, 1, 'x')").bind(r!.id, story!.id),
        db().prepare("INSERT INTO run_members (run_id, community_idx, claim_id) VALUES (?, 0, ?)").bind(r!.id, claimId),
      ]),
      db().prepare("INSERT INTO poll_log (source_id, at, status) SELECT id, ?, 'ok' FROM sources LIMIT 1").bind(oldDay),
      db().prepare("INSERT INTO poll_log (source_id, at, status) SELECT id, ?, 'ok' FROM sources LIMIT 1").bind(NOW - 60),
      db().prepare("INSERT INTO llm_calls (at, model, kind, prompt_version, status) VALUES (?, 'm', 'extract', 1, 'ok')").bind(oldDay),
      ...[0, 3600, 7200].map((offset) => db().prepare("INSERT INTO item_metrics (item_id, captured_at, likes) VALUES (?, ?, ?)").bind(item, oldDay + offset, offset)),
      ...[0, 3600].map((offset) => db().prepare("INSERT INTO item_metrics (item_id, captured_at, likes) VALUES (?, ?, 5)").bind(item, NOW - DAY + offset)),
    ]);

    const report = await runDailyMaintenance(db(), NOW);
    expect(Object.values(report).every((value) => !value.startsWith("failed"))).toBe(true);
    expect(await scalar("SELECT COUNT(*) FROM run_members WHERE run_id = ?", oldRun!.id)).toBe(0);
    expect(await scalar("SELECT COUNT(*) FROM run_members WHERE run_id = ?", recentRun!.id)).toBe(1);
    expect(await scalar("SELECT COUNT(*) FROM poll_log")).toBe(1);
    expect(await scalar("SELECT COUNT(*) FROM llm_calls")).toBe(0);
    // Twenty days ago: three snapshots in one day collapse to the last. Yesterday's stay as they are.
    expect((await db().prepare("SELECT likes FROM item_metrics WHERE item_id = ? AND captured_at < ? ORDER BY captured_at").bind(item, NOW - 14 * DAY).all()).results).toEqual([{ likes: 7200 }]);
    expect(await scalar("SELECT COUNT(*) FROM item_metrics WHERE item_id = ? AND captured_at >= ?", item, NOW - 2 * DAY)).toBe(2);
    expect(await db().prepare("SELECT status, error FROM cluster_runs WHERE id = ?").bind(hungRun!.id).first()).toEqual({ status: "failed", error: "lease expired" });
  });

  it("removes placeholder stories of failed runs but never a story a user acted on", async () => {
    const insert = (first: number) => db().prepare("INSERT INTO stories (headline_vi, first_seen_at, last_claim_at, members_hash, alive) VALUES ('', ?, ?, 'x', 0) RETURNING id").bind(first, first).first<{ id: number }>();
    const orphan = await insert(NOW - 3 * DAY);
    const acted = await insert(NOW - 3 * DAY);
    const tooRecent = await insert(NOW - 3600);
    await db().prepare("INSERT INTO user_actions (story_id, action, at) VALUES (?, 'save', ?)").bind(acted!.id, NOW).run();

    await runDailyMaintenance(db(), NOW);
    const left = (await db().prepare("SELECT id FROM stories ORDER BY id").all<{ id: number }>()).results.map((row) => row.id);
    expect(left).toEqual([acted!.id, tooRecent!.id]);
    expect(left).not.toContain(orphan!.id);
  });

  it("leaves a running job alone while its lease is alive", async () => {
    const running = await db().prepare("INSERT INTO cluster_runs (started_at, heartbeat_at, status, params_json, seed) VALUES (?, ?, 'running', '{}', 42) RETURNING id").bind(NOW - 600, NOW - 600).first<{ id: number }>();
    await db().prepare("INSERT INTO job_leases (name, holder, expires_at) VALUES ('cluster', 'alive', ?)").bind(NOW + 3000).run();
    await runDailyMaintenance(db(), NOW);
    expect(await db().prepare("SELECT status FROM cluster_runs WHERE id = ?").bind(running!.id).first()).toEqual({ status: "running" });
  });
});
