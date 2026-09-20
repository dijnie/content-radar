import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { wipeClusterState } from "../cluster/seed-claims";

// The views read SQLite's clock, so the fixture is laid out relative to the real time.
const NOW = Math.floor(Date.now() / 1000);
const DAY = 86_400;
const HOUR = 3600;
const db = () => env.DB;
const rows = async (sql: string, ...binds: unknown[]) => (await db().prepare(sql).bind(...binds).all<Record<string, unknown>>()).results;

let claimSeq = 0;
async function claim(itemId: number, authorId: number, publishedAt: number, entityId?: number): Promise<number> {
  const n = ++claimSeq;
  const row = await db()
    .prepare("INSERT INTO claims (item_id, author_id, kind, text_vi, text_en, quote, published_at, content_hash, model, prompt_version, created_at) VALUES (?, ?, 'report', ?, 'en text long enough', ?, ?, ?, 'test', 1, ?) RETURNING id")
    .bind(itemId, authorId, `Nhận định số ${n} đủ dài.`, `quote ${n}`, publishedAt, `views-${n}`, publishedAt)
    .first<{ id: number }>();
  if (entityId) await db().prepare("INSERT INTO entity_mentions (claim_id, surface, normalized, entity_id) VALUES (?, 'e', 'e', ?)").bind(row!.id, entityId).run();
  return row!.id;
}

const ids: Record<string, number> = {};

beforeAll(async () => {
  await wipeClusterState(db());
  await db().batch([db().prepare("DELETE FROM author_baselines"), db().prepare("DELETE FROM analyst_signals WHERE 0"), db().prepare("DELETE FROM source_health")]);
  const source = await db().prepare("INSERT INTO sources (type, key, label, poll_interval_min) VALUES ('x', ?, 'views', 30) RETURNING id").bind(`views-${NOW}`).first<{ id: number }>();
  ids.source = source!.id;
  for (const key of ["a", "b", "c", "d"]) {
    ids[`author_${key}`] = (await db().prepare("INSERT INTO authors (author_key, canonical_name) VALUES (?1, ?1) ON CONFLICT(author_key) DO UPDATE SET canonical_name = canonical_name RETURNING id").bind(`views-author-${key}`).first<{ id: number }>())!.id;
  }
  const item = async (key: string, authorKey: string, publishedAt: number) =>
    (ids[key] = (await db().prepare("INSERT INTO items (source_id, platform, external_id, url, canonical_url, author_id, kind, published_at, fetched_at, content_hash, status) VALUES (?, 'x', ?, ?, ?, ?, 'post', ?, ?, 'h', 'extracted') RETURNING id")
      .bind(ids.source, `views-${key}`, `https://x.com/views/${key}`, `https://x.com/views/${key}`, ids[`author_${authorKey}`], publishedAt, publishedAt).first<{ id: number }>())!.id);
  await item("recent", "a", NOW - 2 * DAY);
  await item("old", "b", NOW - 20 * DAY);
  await item("spike", "a", NOW - 30 * HOUR);
  await item("normal", "a", NOW - 30 * HOUR);

  const entity = async (key: string, createdAt: number, provisional = 0) =>
    (ids[key] = (await db().prepare("INSERT INTO entities (canonical_name, type, provisional, created_at) VALUES (?, 'product', ?, ?) RETURNING id").bind(key, provisional, createdAt).first<{ id: number }>())!.id);
  await entity("rising", NOW - 60 * DAY);
  await entity("steady", NOW - 60 * DAY);
  await entity("tiny", NOW - 60 * DAY);
  await entity("brand-new", NOW - 10 * HOUR);

  // rising: 6 claims this week against 3 in the three weeks before (baseline 1 per week) -> ratio 6.
  for (let n = 0; n < 6; n++) await claim(ids.recent!, ids.author_a! + (n % 2), NOW - (1 + n % 5) * DAY, ids.rising);
  for (let n = 0; n < 3; n++) await claim(ids.old!, ids.author_b!, NOW - (10 + n * 5) * DAY, ids.rising);
  // steady: 2 this week, 6 before (baseline 2) -> ratio 1.
  for (let n = 0; n < 2; n++) await claim(ids.recent!, ids.author_a!, NOW - (2 + n) * DAY, ids.steady);
  for (let n = 0; n < 6; n++) await claim(ids.old!, ids.author_b!, NOW - (9 + n * 3) * DAY, ids.steady);
  await claim(ids.recent!, ids.author_a!, NOW - DAY, ids.tiny);
  // brand-new: three different authors within its first hours.
  for (const key of ["a", "b", "c"]) await claim(ids.recent!, ids[`author_${key}`]!, NOW - 5 * HOUR, ids["brand-new"]);

  await db().batch([
    db().prepare("INSERT INTO author_baselines (author_id, platform, metric, median, mad, sample_size, updated_at) VALUES (?, 'x', 'engagement', 100, 10, 30, ?)").bind(ids.author_a, NOW),
    db().prepare("INSERT INTO item_metrics (item_id, captured_at, likes) VALUES (?, ?, 900)").bind(ids.spike, NOW - HOUR),
    db().prepare("INSERT INTO item_metrics (item_id, captured_at, likes) VALUES (?, ?, 105)").bind(ids.normal, NOW - HOUR),
    db().prepare("INSERT INTO source_health (source_id, last_ok_at, last_error, consecutive_failures) VALUES (?, ?, 'blocked:http_403', 6)").bind(ids.source, NOW - 9 * HOUR),
  ]);

  const run = async (status: string) => (await db().prepare("INSERT INTO cluster_runs (started_at, finished_at, heartbeat_at, status, params_json, seed) VALUES (?, ?, ?, ?, '{}', 42) RETURNING id").bind(NOW - HOUR, NOW - HOUR, NOW - HOUR, status).first<{ id: number }>())!.id;
  ids.doneRun = await run("done");
  ids.failedRun = await run("failed");
  const story = async (key: string, fields: string, values: unknown[]) =>
    (ids[key] = (await db().prepare(`INSERT INTO stories (label_text, headline_vi, first_seen_at, last_claim_at, members_hash, ${fields}) VALUES (?, ?, ?, ?, 'h', ${values.map(() => "?").join(", ")}) RETURNING id`).bind(key, `Headline ${key}`, NOW, NOW, ...values).first<{ id: number }>())!.id);
  await story("ready-story", "alive, status, score, has_counter, questions_json", [1, "ready", 80, 1, '["Đo thế nào?","Ai xác nhận?"]']);
  await story("handled-story", "alive, status, score, questions_json", [1, "lead", 75, '["Đã xử lý?"]']);
  await story("weak-story", "alive, status, score, questions_json", [1, "lead", 41, '["Điểm thấp?"]']);
  await story("dead-story", "alive, status, score", [0, "lead", 90]);

  const evidence = await claim(ids.recent!, ids.author_a!, NOW - 2 * DAY);
  const counter = await claim(ids.recent!, ids.author_b!, NOW - 3 * HOUR);
  const left = await claim(ids.recent!, ids.author_c!, NOW - DAY);
  await db().batch([
    db().prepare("INSERT INTO story_claims (story_id, claim_id, role, active, added_run_id) VALUES (?, ?, 'evidence', 1, ?)").bind(ids["ready-story"], evidence, ids.doneRun),
    db().prepare("INSERT INTO story_claims (story_id, claim_id, role, active, added_run_id) VALUES (?, ?, 'counter', 1, ?)").bind(ids["ready-story"], counter, ids.doneRun),
    db().prepare("INSERT INTO story_claims (story_id, claim_id, role, active, added_run_id) VALUES (?, ?, 'context', 0, ?)").bind(ids["ready-story"], left, ids.doneRun),
    db().prepare("INSERT INTO lineage_events (run_id, type, story_id, related_story_id, jaccard, at) VALUES (?, 'split', ?, ?, 0.4, ?)").bind(ids.doneRun, ids["ready-story"], ids["handled-story"], NOW - HOUR),
    db().prepare("INSERT INTO lineage_events (run_id, type, story_id, at) VALUES (?, 'continue', ?, ?)").bind(ids.doneRun, ids["ready-story"], NOW - HOUR),
    db().prepare("INSERT INTO lineage_events (run_id, type, story_id, at) VALUES (?, 'birth', ?, ?)").bind(ids.failedRun, ids["weak-story"], NOW - HOUR),
    db().prepare("INSERT INTO lineage_events (run_id, type, story_id, at) VALUES (?, 'death', ?, ?)").bind(ids.doneRun, ids["dead-story"], NOW - 20 * DAY),
    db().prepare("INSERT INTO analyst_signals (session_label, kind, title, summary_vi, confidence, story_ids_json) VALUES ('s1', 'trend', 't', 'tóm tắt', 0.6, ?)").bind(JSON.stringify([ids["handled-story"]])),
  ]);
});

describe("analyst views", () => {
  it("v_entity_momentum computes the ratio against the weekly baseline and drops thin samples", async () => {
    const result = await rows("SELECT canonical_name, claims_7d, authors_7d, claims_prev_21d, weekly_baseline, ratio FROM v_entity_momentum ORDER BY ratio DESC");
    expect(result).toEqual([
      { canonical_name: "rising", claims_7d: 6, authors_7d: 2, claims_prev_21d: 3, weekly_baseline: 1, ratio: 6 },
      { canonical_name: "steady", claims_7d: 2, authors_7d: 1, claims_prev_21d: 6, weekly_baseline: 2, ratio: 1 },
    ]);
  });

  it("v_anomaly_candidates finds exactly the three kinds of candidate", async () => {
    const result = await rows("SELECT rule, subject_kind, subject_id, label, url, strength FROM v_anomaly_candidates ORDER BY rule");
    expect(result).toEqual([
      { rule: "counter_on_ready_story", subject_kind: "story", subject_id: ids["ready-story"], label: "ready-story", url: null, strength: 1 },
      { rule: "engagement_spike", subject_kind: "item", subject_id: ids.spike, label: "views-author-a", url: "https://x.com/views/spike", strength: expect.any(Number) },
      { rule: "new_entity_many_authors", subject_kind: "entity", subject_id: ids["brand-new"], label: "brand-new", url: null, strength: 3 },
    ]);
    expect(Number(result[1]!.strength)).toBeCloseTo((900 - 100) / 14.826, 1);
  });

  it("v_story_evidence returns the source URL of every active claim and hides claims that left", async () => {
    const result = await rows("SELECT role, author, platform, url, quote FROM v_story_evidence WHERE story_id = ? ORDER BY role", ids["ready-story"]);
    expect(result.map((row) => row.role)).toEqual(["counter", "evidence"]);
    expect(result.every((row) => row.url === "https://x.com/views/recent" && row.platform === "x" && typeof row.quote === "string")).toBe(true);
  });

  it("v_lineage_recent skips failed runs, continue events and events older than 14 days", async () => {
    expect(await rows("SELECT type, label_text, related_label_text FROM v_lineage_recent")).toEqual([{ type: "split", label_text: "ready-story", related_label_text: "handled-story" }]);
  });

  it("v_story_cards lists living stories only", async () => {
    expect((await rows("SELECT label_text, active_claims FROM v_story_cards ORDER BY label_text")).map((row) => row.label_text)).toEqual(["handled-story", "ready-story", "weak-story"]);
  });

  it("v_source_health shows the failing source and how long data has been missing", async () => {
    const [row] = await rows("SELECT label, consecutive_failures, last_error, hours_since_ok FROM v_source_health WHERE source_id = ?", ids.source);
    expect(row).toMatchObject({ label: "views", consecutive_failures: 6, last_error: "blocked:http_403" });
    expect(Number(row!.hours_since_ok)).toBeCloseTo(9, 0);
  });

  it("v_open_questions lists questions of strong stories no signal refers to yet", async () => {
    expect(await rows("SELECT label_text, question FROM v_open_questions ORDER BY question")).toEqual([
      { label_text: "ready-story", question: "Ai xác nhận?" }, { label_text: "ready-story", question: "Đo thế nào?" },
    ]);
  });
});

describe("analyst write-back tables", () => {
  it("accept a status change but refuse deletion and re-attribution", async () => {
    await db().prepare("UPDATE analyst_signals SET status = 'confirmed' WHERE session_label = 's1'").run();
    await expect(db().prepare("DELETE FROM analyst_signals").run()).rejects.toThrow(/append-only/);
    await expect(db().prepare("UPDATE analyst_signals SET session_label = 'forged'").run()).rejects.toThrow(/cannot change/);
    await expect(db().prepare("UPDATE analyst_signals SET created_at = 0").run()).rejects.toThrow(/cannot change/);

    await db().prepare("INSERT INTO analyst_hypotheses (session_label, statement_vi) VALUES ('s1', 'Giả thuyết thử nghiệm.')").run();
    await db().prepare("UPDATE analyst_hypotheses SET status = 'supported', verification_notes_vi = 'đã kiểm', updated_at = ?").bind(NOW).run();
    await expect(db().prepare("DELETE FROM analyst_hypotheses").run()).rejects.toThrow(/append-only/);
    expect(await rows("SELECT status, (SELECT status FROM analyst_hypotheses LIMIT 1) AS hypothesis FROM analyst_signals")).toEqual([{ status: "confirmed", hypothesis: "supported" }]);
  });

  it("reject unknown kinds, statuses and an out-of-range confidence", async () => {
    const insert = (kind: string, confidence: number) => db().prepare("INSERT INTO analyst_signals (session_label, kind, title, summary_vi, confidence) VALUES ('s', ?, 't', 's', ?)").bind(kind, confidence).run();
    await expect(insert("rumour", 0.5)).rejects.toThrow(/CHECK/);
    await expect(insert("trend", 1.5)).rejects.toThrow(/CHECK/);
    await expect(db().prepare("UPDATE analyst_hypotheses SET status = 'proven'").run()).rejects.toThrow(/CHECK/);
  });
});
