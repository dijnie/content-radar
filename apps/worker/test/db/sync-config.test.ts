import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import authors from "../../../../config/authors.json";
import settings from "../../../../config/settings.json";
import sources from "../../../../config/sources.json";
import stopEntities from "../../../../config/stop-entities.json";
import topics from "../../../../config/topics.json";
import { buildSyncStatements, parseConfig, type RawConfig } from "../../../../scripts/sync-config-sql";

const RAW: RawConfig = { topics, sources, authors, settings, stopEntities };

async function sync(raw: RawConfig): Promise<void> {
  await env.DB.batch(buildSyncStatements(parseConfig(raw)).map((sql) => env.DB.prepare(sql)));
}

async function counts(): Promise<Record<string, number>> {
  const row = await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM topics) AS topics, (SELECT COUNT(*) FROM sources) AS sources,
            (SELECT COUNT(*) FROM authors) AS authors, (SELECT COUNT(*) FROM author_handles) AS handles,
            (SELECT COUNT(*) FROM settings) AS settings`,
  ).first<Record<string, number>>();
  return row!;
}

describe("the checked-in config", () => {
  it("is valid and has the agreed shape", () => {
    const config = parseConfig(RAW);
    expect(config.topics.map((topic) => topic.slug)).toEqual(["ai", "system-design", "backend"]);
    const xSources = config.sources.filter((source) => source.type === "x");
    expect(xSources.length).toBeGreaterThanOrEqual(30);
    expect(config.sources.some((source) => (source.type as string) === "reddit")).toBe(false);
    expect(config.settings).toMatchObject({ display_min_score: 40, synthesis_min_score: 30, llm_safe_default_rpd: 20 });
  });
});

describe("config sync", () => {
  it("is idempotent and keeps operational state", async () => {
    await sync(RAW);
    const first = await counts();
    await env.DB.prepare("UPDATE sources SET next_poll_at = 1790000000, cursor_json = '{\"top\":\"abc\"}' WHERE type = 'x' AND key = 'karpathy'").run();

    await sync(RAW);
    expect(await counts()).toEqual(first);
    const source = await env.DB.prepare("SELECT next_poll_at, cursor_json FROM sources WHERE type = 'x' AND key = 'karpathy'").first();
    expect(source).toEqual({ next_poll_at: 1790000000, cursor_json: '{"top":"abc"}' });
  });

  it("links every handle of one person to a single author", async () => {
    await sync(RAW);
    const { results } = await env.DB.prepare(
      `SELECT h.platform, h.handle FROM author_handles h JOIN authors a ON a.id = h.author_id
       WHERE a.author_key = 'simon-willison' ORDER BY h.platform`,
    ).all();
    expect(results).toEqual([
      { platform: "hn", handle: "simonw" },
      { platform: "rss", handle: "simonwillison.net" },
      { platform: "x", handle: "simonw" },
    ]);
  });

  it("disables a removed source instead of deleting it", async () => {
    await sync(RAW);
    await sync({ ...RAW, sources: sources.filter((source) => source.key !== "karpathy") });
    const row = await env.DB.prepare("SELECT enabled FROM sources WHERE type = 'x' AND key = 'karpathy'").first<{ enabled: number }>();
    expect(row?.enabled).toBe(0);
  });
});

describe("config validation", () => {
  it("rejects a malformed X handle", () => {
    const bad = [...sources, { type: "x", key: "not/a/handle", label: "Bad", pollIntervalMin: 30 }];
    expect(() => parseConfig({ ...RAW, sources: bad })).toThrow();
  });

  it("rejects a Reddit source, an unknown topic and an unknown author", () => {
    expect(() => parseConfig({ ...RAW, sources: [{ type: "reddit", key: "r/ai", label: "Reddit", pollIntervalMin: 60 }] })).toThrow();
    const unknownTopic = [{ type: "hn", key: "q", label: "Q", topicHint: "crypto", pollIntervalMin: 30 }];
    expect(() => parseConfig({ ...RAW, sources: unknownTopic })).toThrow(/unknown topic/);
    const unknownAuthor = [{ type: "hn", key: "q", label: "Q", authorKey: "nobody", pollIntervalMin: 30 }];
    expect(() => parseConfig({ ...RAW, sources: unknownAuthor })).toThrow(/unknown author/);
  });

  it("escapes quotes in values", async () => {
    const quoted = [...sources, { type: "hn", key: "it's", label: "O'Reilly \"quotes\"", pollIntervalMin: 30 }];
    await sync({ ...RAW, sources: quoted });
    const row = await env.DB.prepare("SELECT label FROM sources WHERE type = 'hn' AND key = ?").bind("it's").first<{ label: string }>();
    expect(row?.label).toBe("O'Reilly \"quotes\"");
  });
});
