import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { handleStatus } from "../../src/api/status-route";
import { handleStoryAction, handleStoryDetail, handleStoryList, likePattern } from "../../src/api/stories-routes";
import { searchable } from "../../src/cluster/score-step";
import { seedClaims, wipeClusterState } from "../cluster/seed-claims";

const NOW = Date.UTC(2026, 8, 20, 12, 0, 0) / 1000;
const list = async (query = "") => (await (await handleStoryList(new Request(`https://radar.example.com/api/stories${query}`), env)).json()) as { stories: { id: number; score: number; lastClaimAt: number; label: string; claims: { role: string; url: string }[]; links: { url: string }[] }[]; nextCursor: string | null; counts: Record<string, number>; topics: unknown[]; timezone: string };

interface Seed { label: string; score: number; state?: string; topics?: string[]; alive?: number; age?: number; headline?: string }
const ids = new Map<string, number>();

beforeAll(async () => {
  await wipeClusterState(env.DB);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO topics (slug, name) VALUES ('ai', 'AI'), ('backend', 'Backend') ON CONFLICT(slug) DO NOTHING"),
    env.DB.prepare("INSERT INTO settings (key, value_json) VALUES ('display_min_score', '40'), ('display_timezone', '\"Asia/Ho_Chi_Minh\"') ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json"),
  ]);
  const seeds: Seed[] = [
    { label: "deepseek", score: 85.4, topics: ["ai"], age: 5, headline: "Theo số đếm của geekbb, DeepSeek đã chuyển 12,1 triệu request." },
    { label: "postgres 100%_safe", score: 78.6, topics: ["backend"], age: 1 },
    { label: "opencode go", score: 72.5, topics: ["ai"], age: 3 },
    { label: "below the bar", score: 39.9, topics: ["ai"], age: 2 },
    { label: "dead story", score: 90, topics: ["ai"], alive: 0 },
    { label: "kept", score: 60, state: "saved", topics: ["ai"] },
    { label: "done", score: 55, state: "written", topics: ["ai"], alive: 0 },
    { label: "noise", score: 50, state: "dismissed", topics: ["ai"] },
    ...Array.from({ length: 7 }, (_, n): Seed => ({ label: `tie ${n}`, score: 45, topics: ["backend"], age: 10 })),
  ];
  for (const seed of seeds) {
    const row = await env.DB
      .prepare("INSERT INTO stories (label_text, headline_vi, score, user_state, topics_json, search_text, first_seen_at, last_claim_at, members_hash, alive, subscores_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'h', ?, '{\"sources\":0.4}') RETURNING id")
      .bind(seed.label, seed.headline ?? `Headline ${seed.label}`, seed.score, seed.state ?? "inbox", JSON.stringify(seed.topics ?? []), searchable([seed.label, seed.headline ?? ""]), NOW, NOW - (seed.age ?? 0) * 3600, seed.alive ?? 1)
      .first<{ id: number }>();
    ids.set(seed.label, row!.id);
  }
  const claimIds = await seedClaims(env.DB, [{ tag: "S1", publishedAt: NOW - 3600 }, { tag: "S1", publishedAt: NOW - 7200 }, { tag: "S1", publishedAt: NOW - 9000 }, { tag: "S1", publishedAt: NOW - 100 }]);
  const run = await env.DB.prepare("INSERT INTO cluster_runs (started_at, heartbeat_at, status, params_json, seed) VALUES (?, ?, 'done', '{}', 42) RETURNING id").bind(NOW, NOW).first<{ id: number }>();
  const roles = ["context", "counter", "evidence", "evidence"];
  await env.DB.batch(claimIds.map((id, n) => env.DB.prepare("INSERT INTO story_claims (story_id, claim_id, role, active, added_run_id) VALUES (?, ?, ?, ?, ?)").bind(ids.get("deepseek"), id, roles[n], n === 3 ? 0 : 1, run!.id)));
});

describe("GET /api/stories", () => {
  it("inbox shows living inbox stories above the display score, best first, with tab counts and topics", async () => {
    const body = await list();
    expect(body.stories.slice(0, 3).map((story) => story.label)).toEqual(["deepseek", "postgres 100%_safe", "opencode go"]);
    expect(body.stories.map((story) => story.label)).not.toContain("below the bar");
    expect(body.stories.map((story) => story.label)).not.toContain("dead story");
    expect(body.counts).toEqual({ inbox: 10, saved: 2, dismissed: 1 });
    expect(body.topics).toEqual(expect.arrayContaining([{ slug: "ai", name: "AI" }]));
    expect(body.timezone).toBe("Asia/Ho_Chi_Minh");
  });

  it("orders card lines evidence, counter, context, hides inactive claims, and takes links from items", async () => {
    const card = (await list()).stories.find((story) => story.label === "deepseek")!;
    expect(card.claims.map((claim) => claim.role)).toEqual(["evidence", "counter", "context"]);
    expect(card.links).toHaveLength(3);
    expect(card.links.every((link) => link.url.startsWith("https://x.com/"))).toBe(true);
  });

  it("filters by tab, including written under saved and dead stories the user kept", async () => {
    expect((await list("?tab=saved")).stories.map((story) => story.label)).toEqual(["kept", "done"]);
    expect((await list("?tab=dismissed")).stories.map((story) => story.label)).toEqual(["noise"]);
  });

  it("filters by topic and sorts by newest", async () => {
    const backend = await list("?topic=backend&sort=newest");
    expect(backend.stories[0]!.label).toBe("postgres 100%_safe");
    expect(backend.stories).toHaveLength(8);
    expect((await list("?topic=ai")).stories.map((story) => story.label)).toEqual(["deepseek", "opencode go"]);
  });

  it("searches accent-insensitively and treats % and _ literally", async () => {
    expect((await list("?q=DEEPSEEK")).stories.map((story) => story.label)).toEqual(["deepseek"]);
    expect((await list(`?q=${encodeURIComponent("so dem cua")}`)).stories.map((story) => story.label)).toEqual(["deepseek"]);
    expect((await list(`?q=${encodeURIComponent("100%_safe")}`)).stories.map((story) => story.label)).toEqual(["postgres 100%_safe"]);
    expect((await list(`?q=${encodeURIComponent("%")}`)).stories.map((story) => story.label)).toEqual(["postgres 100%_safe"]);
    expect((await list(`?q=${encodeURIComponent("100x_safe")}`)).stories).toEqual([]);
    expect(likePattern("50%_a\\b")).toBe("%50\\%\\_a\\\\b%");
  });

  it.each(["score", "newest"])("paginates by %s without repeating or skipping a card, even across ties", async (sort) => {
    const seen: number[] = [];
    let cursor: string | null = null;
    do {
      const page = await list(`?sort=${sort}&limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      seen.push(...page.stories.map((story) => story.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toHaveLength(10);
    expect(new Set(seen).size).toBe(10);
    expect(seen).toEqual((await list(`?sort=${sort}&limit=60`)).stories.map((story) => story.id));
  });

  it("rejects bad parameters", async () => {
    for (const query of ["?tab=all", "?sort=random", "?cursor=abc", "?cursor=1:2;DROP", "?sort=constructor", "?tab=__proto__", "?tab=toString", "?sort=hasOwnProperty"]) {
      expect((await handleStoryList(new Request(`https://radar.example.com/api/stories${query}`), env)).status, query).toBe(400);
    }
  });
});

describe("story detail and actions", () => {
  it("returns claims with quote, author, platform and source URL, plus sub-scores", async () => {
    const response = await handleStoryDetail(env, ids.get("deepseek")!);
    const { story } = (await response.json()) as { story: { claims: Record<string, unknown>[]; subscores: Record<string, number> } };
    expect(story.claims).toHaveLength(3);
    expect(story.claims[0]).toMatchObject({ role: "evidence", platform: "x", quote: expect.any(String), author: expect.any(String), url: expect.stringMatching(/^https:/) });
    expect(story.subscores).toEqual({ sources: 0.4 });
    expect((await handleStoryDetail(env, 987_654)).status).toBe(404);
  });

  it("records the action with the score at that moment and moves the card between tabs", async () => {
    const id = ids.get("opencode go")!;
    const act = (action: unknown) => handleStoryAction(new Request("https://radar.example.com/x", { method: "POST", body: JSON.stringify({ action }) }), env, id);
    expect(await (await act("save")).json()).toEqual({ id, userState: "saved" });
    expect((await list()).stories.map((story) => story.id)).not.toContain(id);
    expect((await list("?tab=saved")).stories.map((story) => story.id)).toContain(id);
    expect(await (await act("written")).json()).toEqual({ id, userState: "written" });
    expect(await (await act("restore")).json()).toEqual({ id, userState: "inbox" });

    const log = (await env.DB.prepare("SELECT action, score_at_action, subscores_json FROM user_actions WHERE story_id = ? ORDER BY id").bind(id).all()).results;
    expect(log).toEqual(["save", "written", "restore"].map((action) => ({ action, score_at_action: 72.5, subscores_json: '{"sources":0.4}' })));
    expect((await act("delete")).status).toBe(400);
    expect((await handleStoryAction(new Request("https://radar.example.com/x", { method: "POST", body: "{" }), env, id)).status).toBe(400);
    expect((await handleStoryAction(new Request("https://radar.example.com/x", { method: "POST", body: '{"action":"save"}' }), env, 987_654)).status).toBe(404);
  });
});

describe("GET /api/status", () => {
  it("reports sources, backlog, budget, circuit, runs and fallback headlines", async () => {
    const body = (await (await handleStatus(env, NOW)).json()) as Record<string, any>;
    expect(body.pacificDay).toBe("2026-09-20");
    expect(body.llm.models.map((model: { model: string }) => model.model)).toEqual(["gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.6-flash"]);
    expect(body.llm).toMatchObject({ circuitOpenUntil: null, reservedShare: 0.2 });
    expect(body.clusterRuns[0]).toMatchObject({ status: "done" });
    expect(body.cards).toMatchObject({ alive: 13, fallbackHeadlines: 13 });
    expect(Array.isArray(body.sources) && Array.isArray(body.backlog)).toBe(true);
  });
});
