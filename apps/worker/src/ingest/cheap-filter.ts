import type { NormalizedItem } from "../sources/source-adapter";

export interface TopicKeywords {
  slug: string;
  keywords: string[];
}

export interface FilterConfig {
  languages: string[];
  minTextLength: number;
  topics: TopicKeywords[];
}

export type FilterDecision = { pass: true; topicHint: string | null } | { pass: false; reason: string };

const URLS = /https?:\/\/\S+/g;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whole-word, case-insensitive match; "ai" must not fire inside "maintain". */
export function keywordPattern(keywords: readonly string[]): RegExp | null {
  if (keywords.length === 0) return null;
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${keywords.map(escapeRegExp).join("|")})(?![\\p{L}\\p{N}])`, "iu");
}

const patterns = new WeakMap<TopicKeywords, RegExp | null>();

function matchTopic(text: string, topics: readonly TopicKeywords[], preferred: string | null): string | null {
  const ordered = [...topics].sort((a, b) => Number(b.slug === preferred) - Number(a.slug === preferred));
  for (const topic of ordered) {
    if (!patterns.has(topic)) patterns.set(topic, keywordPattern(topic.keywords));
    if (patterns.get(topic)?.test(text)) return topic.slug;
  }
  return null;
}

/**
 * Cheap pre-filter, rules in order. It only decides what is worth an LLM call;
 * the final relevance check belongs to the extraction step.
 */
export function cheapFilter(
  item: NormalizedItem,
  source: { always_pass: number; topic_hint: string | null },
  config: FilterConfig,
): FilterDecision {
  // Reposts are stored for the relation they carry, never extracted.
  if (item.kind === "repost") return { pass: false, reason: "repost" };
  if (item.kind === "reply") {
    const selfReply = item.replyToHandle != null && item.author != null && item.replyToHandle.toLowerCase() === item.author.handle.toLowerCase();
    if (!selfReply) return { pass: false, reason: "reply" };
  }
  const prose = item.text.replace(URLS, " ").replace(/\s+/g, " ").trim();
  if (prose.length < config.minTextLength) return { pass: false, reason: "too_short" };
  if (item.lang && !config.languages.includes(item.lang.toLowerCase().slice(0, 2))) return { pass: false, reason: "language" };

  const topic = matchTopic(item.text, config.topics, source.topic_hint);
  // Comments inherit relevance from the story that brought them in.
  if (source.always_pass === 1 || item.kind === "comment") return { pass: true, topicHint: topic ?? source.topic_hint };
  return topic ? { pass: true, topicHint: topic } : { pass: false, reason: "no_topic_match" };
}
