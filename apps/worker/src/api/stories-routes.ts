import { searchable } from "../cluster/score-step";
import { chunkForParams, nowSeconds, placeholders } from "../db/batch";
import { getSetting } from "../db/settings-repo";
import { applyUserAction, getStory, type StoryRow, type UserAction } from "../db/stories-repo";
import type { Env } from "../env";
import { jsonError } from "./api-errors";

const TABS = { inbox: "s.alive = 1 AND s.user_state = 'inbox' AND s.score >= ?", saved: "s.user_state IN ('saved', 'written')", dismissed: "s.user_state = 'dismissed'" } as const;
type Tab = keyof typeof TABS;
const SORTS = { score: "s.score", newest: "s.last_claim_at" } as const;
type Sort = keyof typeof SORTS;
const ACTIONS: readonly UserAction[] = ["save", "dismiss", "written", "restore"];
const ROLE_ORDER = "CASE sc.role WHEN 'evidence' THEN 0 WHEN 'counter' THEN 1 WHEN 'context' THEN 2 ELSE 3 END";
const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 60;
const LINES_PER_CARD = 8;

interface ClaimLine {
  storyId: number;
  claimId: number;
  role: string;
  textVi: string;
  quote: string;
  author: string | null;
  platform: string;
  url: string;
  publishedAt: number;
}

function storyJson(row: StoryRow) {
  return {
    id: row.id, label: row.label_text, headline: row.headline_vi, headlineSource: row.headline_source, status: row.status, score: row.score,
    independentSources: row.independent_sources, questions: JSON.parse(row.questions_json) as string[], hasCounter: row.has_counter === 1,
    topics: JSON.parse(row.topics_json) as string[], userState: row.user_state, alive: row.alive === 1, firstSeenAt: row.first_seen_at, lastClaimAt: row.last_claim_at,
  };
}

/** URLs always come from `items.url`, which a re-poll can never rewrite; never from anything an LLM produced. */
async function claimLines(db: D1Database, storyIds: readonly number[]): Promise<Map<number, ClaimLine[]>> {
  const byStory = new Map<number, ClaimLine[]>();
  for (const chunk of chunkForParams(storyIds)) {
    const { results } = await db
      .prepare(
        `SELECT sc.story_id AS storyId, c.id AS claimId, sc.role, c.text_vi AS textVi, c.quote, a.canonical_name AS author, i.platform, i.url, c.published_at AS publishedAt
         FROM story_claims sc JOIN claims c ON c.id = sc.claim_id JOIN items i ON i.id = c.item_id LEFT JOIN authors a ON a.id = c.author_id
         WHERE sc.active = 1 AND sc.story_id IN (${placeholders(chunk.length)})
         ORDER BY sc.story_id, ${ROLE_ORDER}, c.has_numbers + c.first_hand DESC, c.published_at, c.id`,
      )
      .bind(...chunk)
      .all<ClaimLine>();
    for (const line of results) byStory.set(line.storyId, [...(byStory.get(line.storyId) ?? []), line]);
  }
  return byStory;
}

/** `LIKE` pattern for the normalized search column, with the wildcard characters taken literally. */
export function likePattern(query: string): string {
  return `%${searchable([query]).replace(/[\\%_]/g, "\\$&")}%`;
}

export async function handleStoryList(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const tab = (url.searchParams.get("tab") ?? "inbox") as Tab;
  const sort = (url.searchParams.get("sort") ?? "score") as Sort;
  // hasOwn, not `in`: "constructor" and "__proto__" are keys of every object through the prototype chain.
  if (!Object.hasOwn(TABS, tab)) return jsonError(400, "invalid_tab");
  if (!Object.hasOwn(SORTS, sort)) return jsonError(400, "invalid_sort");
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(url.searchParams.get("limit")) || DEFAULT_LIMIT));
  const minScore = (await getSetting<number>(env.DB, "display_min_score")) ?? 40;

  const where: string[] = [TABS[tab]];
  const binds: unknown[] = tab === "inbox" ? [minScore] : [];
  const topic = url.searchParams.get("topic");
  if (topic) {
    where.push("EXISTS (SELECT 1 FROM json_each(s.topics_json) WHERE value = ?)");
    binds.push(topic);
  }
  const query = url.searchParams.get("q")?.trim();
  if (query) {
    where.push("s.search_text LIKE ? ESCAPE '\\'");
    binds.push(likePattern(query));
  }
  // Keyset pagination on (sort value, id): stable while rows are added, no skipped or repeated cards.
  const cursor = url.searchParams.get("cursor");
  if (cursor) {
    const match = /^(-?\d+(?:\.\d+)?):(\d+)$/.exec(cursor);
    if (!match) return jsonError(400, "invalid_cursor");
    where.push(`(${SORTS[sort]} < ? OR (${SORTS[sort]} = ? AND s.id < ?))`);
    binds.push(Number(match[1]), Number(match[1]), Number(match[2]));
  }

  const { results } = await env.DB
    .prepare(`SELECT s.* FROM stories s WHERE ${where.join(" AND ")} ORDER BY ${SORTS[sort]} DESC, s.id DESC LIMIT ?`)
    .bind(...binds, limit + 1)
    .all<StoryRow>();
  const page = results.slice(0, limit);
  const last = page.at(-1);
  const lines = await claimLines(env.DB, page.map((row) => row.id));
  const counts = await env.DB
    .prepare(
      `SELECT (SELECT COUNT(*) FROM stories s WHERE ${TABS.inbox}) AS inbox,
              (SELECT COUNT(*) FROM stories s WHERE ${TABS.saved}) AS saved,
              (SELECT COUNT(*) FROM stories s WHERE ${TABS.dismissed}) AS dismissed`,
    )
    .bind(minScore)
    .first<Record<Tab, number>>();
  const { results: topics } = await env.DB.prepare("SELECT slug, name FROM topics WHERE enabled = 1 ORDER BY id").all<{ slug: string; name: string }>();

  return Response.json({
    stories: page.map((row) => {
      const all = lines.get(row.id) ?? [];
      return { ...storyJson(row), claims: all.slice(0, LINES_PER_CARD), claimCount: all.length, links: [...new Map(all.map((line) => [line.url, { url: line.url, author: line.author, platform: line.platform }])).values()].slice(0, 10) };
    }),
    nextCursor: results.length > limit && last ? `${sort === "score" ? last.score : last.last_claim_at}:${last.id}` : null,
    counts, topics, timezone: (await getSetting<string>(env.DB, "display_timezone")) ?? "UTC",
  });
}

export async function handleStoryDetail(env: Env, id: number): Promise<Response> {
  const row = await getStory(env.DB, id);
  if (!row) return jsonError(404, "story_not_found");
  const lines = (await claimLines(env.DB, [id])).get(id) ?? [];
  // Only events of finished runs are real; a half-written run leaves rows nobody should read.
  const { results: lineage } = await env.DB
    .prepare("SELECT e.type, e.related_story_id AS relatedStoryId, e.jaccard, e.at FROM lineage_events e JOIN cluster_runs r ON r.id = e.run_id WHERE r.status = 'done' AND e.story_id = ? AND e.type != 'continue' ORDER BY e.at DESC, e.id DESC LIMIT 50")
    .bind(id)
    .all();
  return Response.json({ story: { ...storyJson(row), subscores: JSON.parse(row.subscores_json) as Record<string, number>, claims: lines, lineage } });
}

export async function handleStoryAction(request: Request, env: Env, id: number): Promise<Response> {
  let body: { action?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return jsonError(400, "invalid_json");
  }
  if (typeof body.action !== "string" || !ACTIONS.includes(body.action as UserAction)) return jsonError(400, "invalid_action", { actions: ACTIONS });
  if (!(await applyUserAction(env.DB, id, body.action as UserAction, nowSeconds()))) return jsonError(404, "story_not_found");
  const row = await getStory(env.DB, id);
  return Response.json({ id, userState: row?.user_state });
}
