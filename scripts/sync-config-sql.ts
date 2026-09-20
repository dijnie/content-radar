import { z } from "zod";
import { normalizeHandle } from "../packages/core/src/platform.ts";
import {
  authorSchema,
  settingsSchema,
  sourceSchema,
  stopEntitiesSchema,
  topicSchema,
  X_HANDLE_PATTERN,
} from "../config/config.schema.ts";

export interface RawConfig {
  topics: unknown;
  sources: unknown;
  authors: unknown;
  settings: unknown;
  stopEntities: unknown;
}

export function parseConfig(raw: RawConfig) {
  const config = {
    topics: z.array(topicSchema).min(1).parse(raw.topics),
    sources: z.array(sourceSchema).min(1).parse(raw.sources),
    authors: z.array(authorSchema).parse(raw.authors),
    settings: settingsSchema.parse(raw.settings),
    stopEntities: stopEntitiesSchema.parse(raw.stopEntities),
  };

  const problems: string[] = [];
  const topicSlugs = new Set(config.topics.map((topic) => topic.slug));
  const authorKeys = new Set(config.authors.map((author) => author.authorKey));
  const duplicates = (values: string[]) => values.filter((value, index) => values.indexOf(value) !== index);

  for (const slug of duplicates(config.topics.map((topic) => topic.slug))) problems.push(`duplicate topic ${slug}`);
  for (const key of duplicates(config.authors.map((author) => author.authorKey))) problems.push(`duplicate author ${key}`);
  for (const key of duplicates(config.sources.map((source) => `${source.type}:${source.key.toLowerCase()}`))) {
    problems.push(`duplicate source ${key}`);
  }
  for (const source of config.sources) {
    if (source.topicHint && !topicSlugs.has(source.topicHint)) problems.push(`source ${source.key}: unknown topic ${source.topicHint}`);
    if (source.authorKey && !authorKeys.has(source.authorKey)) problems.push(`source ${source.key}: unknown author ${source.authorKey}`);
  }
  const handles = config.authors.flatMap((author) =>
    author.handles.map((handle) => `${handle.platform}:${normalizeHandle(handle.platform, handle.handle)}`),
  );
  for (const handle of duplicates(handles)) problems.push(`handle ${handle} belongs to more than one author`);
  for (const author of config.authors) {
    for (const handle of author.handles) {
      if (handle.platform === "x" && !X_HANDLE_PATTERN.test(handle.handle)) {
        problems.push(`author ${author.authorKey}: invalid X handle ${handle.handle}`);
      }
    }
  }
  if (problems.length > 0) throw new Error(`invalid config:\n- ${problems.join("\n- ")}`);
  return config;
}

export type ParsedConfig = ReturnType<typeof parseConfig>;

// `wrangler d1 execute` takes SQL text without bound parameters, so values are
// written as literals. Input is the repo's own validated config, never crawl data.
function text(value: string | undefined | null): string {
  if (value === undefined || value === null) return "NULL";
  if (value.includes("\u0000")) throw new Error("config values must not contain NUL characters");
  return `'${value.replaceAll("'", "''")}'`;
}

const flag = (value: boolean): string => (value ? "1" : "0");

/**
 * Idempotent statements. Operational state (`next_poll_at`, `cursor_json`,
 * health, history) is never touched; entries removed from the files are
 * disabled rather than deleted so their history stays.
 */
export function buildSyncStatements(config: ParsedConfig): string[] {
  const statements: string[] = [];

  for (const topic of config.topics) {
    statements.push(
      `INSERT INTO topics (slug, name, keywords_json, enabled) VALUES (${text(topic.slug)}, ${text(topic.name)}, ${text(JSON.stringify(topic.keywords))}, ${flag(topic.enabled)}) ` +
        `ON CONFLICT(slug) DO UPDATE SET name = excluded.name, keywords_json = excluded.keywords_json, enabled = excluded.enabled`,
    );
  }
  statements.push(`UPDATE topics SET enabled = 0 WHERE slug NOT IN (${config.topics.map((topic) => text(topic.slug)).join(", ")})`);

  for (const author of config.authors) {
    statements.push(
      `INSERT INTO authors (author_key, canonical_name) VALUES (${text(author.authorKey)}, ${text(author.name)}) ` +
        `ON CONFLICT(author_key) DO UPDATE SET canonical_name = excluded.canonical_name`,
    );
    for (const handle of author.handles) {
      // The config is the authority for the handles it declares.
      statements.push(
        `INSERT INTO author_handles (author_id, platform, handle) ` +
          `SELECT id, ${text(handle.platform)}, ${text(normalizeHandle(handle.platform, handle.handle))} FROM authors WHERE author_key = ${text(author.authorKey)} ` +
          `ON CONFLICT(platform, handle) DO UPDATE SET author_id = excluded.author_id`,
      );
    }
  }

  for (const source of config.sources) {
    statements.push(
      `INSERT INTO sources (type, key, label, topic_hint, author_key, priority, poll_interval_min, always_pass, enabled) VALUES (` +
        `${text(source.type)}, ${text(source.key)}, ${text(source.label)}, ${text(source.topicHint)}, ${text(source.authorKey)}, ` +
        `${source.priority}, ${source.pollIntervalMin}, ${flag(source.alwaysPass)}, ${flag(source.enabled)}) ` +
        `ON CONFLICT(type, key) DO UPDATE SET label = excluded.label, topic_hint = excluded.topic_hint, author_key = excluded.author_key, ` +
        `priority = excluded.priority, poll_interval_min = excluded.poll_interval_min, always_pass = excluded.always_pass, enabled = excluded.enabled`,
    );
  }
  const declared = config.sources.map((source) => `(${text(source.type)}, ${text(source.key)})`).join(", ");
  statements.push(`UPDATE sources SET enabled = 0 WHERE (type, key) NOT IN (VALUES ${declared})`);

  const settings: Record<string, unknown> = { ...config.settings, stop_entities: config.stopEntities };
  for (const [key, value] of Object.entries(settings)) {
    statements.push(
      `INSERT INTO settings (key, value_json) VALUES (${text(key)}, ${text(JSON.stringify(value))}) ` +
        `ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`,
    );
  }
  return statements;
}
