import { z } from "zod";
import type { EditorialEntry, EditorialFeedResponse } from "@radar/core";
import { searchable } from "../cluster/score-step";
import { getSetting } from "../db/settings-repo";
import type { Env } from "../env";
import { isFeed } from "../jobs/feed-runs";
import { jsonError } from "./api-errors";

const querySchema = z.object({
  window: z.enum(["recent", "7d"]).default("recent"),
  category: z.enum(["toolbox", "field-tests", "playbooks"]).default("toolbox"),
  months: z.coerce.number().int().min(1).max(3).default(1),
  state: z.enum(["unread", "read"]).default("unread"),
  pillar: z.string().max(40).regex(/^[a-z-]*$/).default(""),
  sort: z.enum(["relevance", "newest"]).default("relevance"),
  q: z.string().trim().max(200).default(""),
  page: z.coerce.number().int().min(1).max(100000).default(1),
});
const like = (q: string) => `%${searchable([q]).replace(/[\\%_]/g, "\\$&")}%`;
interface Published { id: number; crawl_id: number; finished_at: number; item_count: number; metadata_json: string }

async function publication(db: D1Database, feed: string): Promise<Published | null> {
  return db.prepare(`SELECT r.id, r.crawl_id, r.finished_at, r.item_count, r.metadata_json FROM feed_publications p
    JOIN feed_runs r ON r.id = p.run_id AND r.status = 'done' WHERE p.feed = ?`).bind(feed).first<Published>();
}

export async function handleFeed(request: Request, env: Env, feed: string, now = Math.floor(Date.now() / 1000)): Promise<Response> {
  if (!isFeed(feed)) return jsonError(400, "invalid_feed");
  const parsed = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) return jsonError(400, "invalid_feed_filters");
  const query = parsed.data;
  const pageSize = feed === "hands-on" ? 6 : 20;
  const [run, timezone] = await Promise.all([publication(env.DB, feed), getSetting<string>(env.DB, "display_timezone")]);
  const body: EditorialFeedResponse = { feed, publication: run ? { runId: run.id, crawlId: run.crawl_id, publishedAt: run.finished_at, total: run.item_count } : null,
    entries: [], total: 0, eligible: 0, page: query.page, pageSize, counts: {}, pillars: [], threshold: null, timezone: timezone ?? "UTC", scoring: {}, awaitingEditorial: 0 };
  if (!run) return Response.json(body);
  const metadata = JSON.parse(run.metadata_json) as { threshold?: number; scoring?: Record<string, unknown>; awaitingEditorial?: number };
  body.threshold = metadata.threshold ?? null;
  body.scoring = metadata.scoring ?? {};
  body.awaitingEditorial = metadata.awaitingEditorial ?? 0;
  const clauses = ["e.run_id = ?"];
  const binds: (string | number)[] = [run.id];
  if (feed === "news") {
    clauses.push("e.score >= ?", "e.published_at >= ?");
    binds.push(body.threshold ?? 0, now - (query.window === "recent" ? 1 : 7) * 86400);
  }
  if (feed === "hands-on") { clauses.push("e.category = ?"); binds.push(query.category); }
  if (feed === "deep-dives") {
    clauses.push("e.published_at >= ?", query.state === "read" ? "rs.entry_key IS NOT NULL" : "rs.entry_key IS NULL");
    binds.push(now - query.months * 30 * 86400);
    if (query.pillar) { clauses.push("e.pillar = ?"); binds.push(query.pillar); }
    if (query.q) { clauses.push("e.search_text LIKE ? ESCAPE '\\'"); binds.push(like(query.q)); }
  }
  const from = "feed_entries e LEFT JOIN feed_read_state rs ON rs.entry_key = e.entry_key";
  const where = clauses.join(" AND ");
  const order = feed === "news" || query.sort === "newest" ? "e.published_at DESC, e.score DESC, e.entry_key" : "e.score DESC, e.published_at DESC, e.entry_key";
  const [rows, total, facets, pillars] = await Promise.all([
    env.DB.prepare(`SELECT e.payload_json, rs.read_at FROM ${from} WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`).bind(...binds, pageSize, (query.page - 1) * pageSize).all<{ payload_json: string; read_at: number | null }>(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM ${from} WHERE ${where}`).bind(...binds).first<{ n: number }>(),
    env.DB.prepare(`SELECT e.category, COUNT(*) AS n,
      SUM(e.published_at >= ?1) AS month1, SUM(e.published_at >= ?2) AS month2, SUM(e.published_at >= ?3) AS month3,
      SUM(CASE WHEN e.published_at >= ?4 THEN rs.entry_key IS NOT NULL ELSE 0 END) AS read,
      SUM(CASE WHEN e.published_at >= ?4 THEN rs.entry_key IS NULL ELSE 0 END) AS unread
      FROM ${from} WHERE e.run_id = ?5 GROUP BY e.category`)
      .bind(now - 30 * 86400, now - 60 * 86400, now - 90 * 86400, now - query.months * 30 * 86400, run.id)
      .all<{ category: string; n: number; month1: number; month2: number; month3: number; read: number; unread: number }>(),
    env.DB.prepare("SELECT DISTINCT pillar FROM feed_entries WHERE run_id = ? ORDER BY pillar").bind(run.id).all<{ pillar: string }>(),
  ]);
  body.entries = rows.results.map((row) => ({ ...JSON.parse(row.payload_json) as EditorialEntry, read: row.read_at !== null }));
  body.total = total?.n ?? 0;
  body.eligible = body.total;
  body.pillars = pillars.results.map((row) => row.pillar);
  for (const facet of facets.results) {
    body.counts[facet.category] = facet.n;
    if (feed === "deep-dives") Object.assign(body.counts, { month1: facet.month1, month2: facet.month2, month3: facet.month3, read: facet.read, unread: facet.unread });
  }
  return Response.json(body);
}

export async function handleFeedRead(request: Request, env: Env, now = Math.floor(Date.now() / 1000)): Promise<Response> {
  const parsed = z.object({ key: z.string().regex(/^item:\d+$/), read: z.boolean() }).safeParse(await request.json().catch(() => null));
  if (!parsed.success) return jsonError(400, "invalid_read_action");
  const { key, read } = parsed.data;
  const exists = await env.DB.prepare(`SELECT 1 FROM feed_entries e JOIN feed_runs r ON r.id = e.run_id AND r.status = 'done'
    WHERE e.entry_key = ? AND r.feed = 'deep-dives' LIMIT 1`).bind(key).first();
  if (!exists) return jsonError(404, "entry_not_found");
  if (read) await env.DB.prepare("INSERT INTO feed_read_state (entry_key, read_at) VALUES (?, ?) ON CONFLICT(entry_key) DO UPDATE SET read_at = excluded.read_at").bind(key, now).run();
  else await env.DB.prepare("DELETE FROM feed_read_state WHERE entry_key = ?").bind(key).run();
  return Response.json({ key, read });
}

export async function handleFeedDetail(request: Request, env: Env, feed: string): Promise<Response> {
  if (!isFeed(feed)) return jsonError(400, "invalid_feed");
  const key = new URL(request.url).searchParams.get("key");
  if (!key || key.length > 200) return jsonError(400, "invalid_entry_key");
  const run = await publication(env.DB, feed);
  if (!run) return jsonError(404, "entry_not_found");
  const row = await env.DB.prepare(`SELECT e.payload_json, rs.read_at FROM feed_entries e
    LEFT JOIN feed_read_state rs ON rs.entry_key = e.entry_key WHERE e.run_id = ? AND e.entry_key = ?`)
    .bind(run.id, key).first<{ payload_json: string; read_at: number | null }>();
  return row ? Response.json({ entry: { ...JSON.parse(row.payload_json) as EditorialEntry, read: row.read_at !== null }, publication: { runId: run.id, crawlId: run.crawl_id, publishedAt: run.finished_at } }) : jsonError(404, "entry_not_found");
}
