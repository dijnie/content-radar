import { z } from "zod";
import { PLATFORMS, X_HANDLE_PATTERN } from "../packages/core/src/platform.ts";
import { editorialScoringSchema } from "../apps/worker/src/feeds/editorial-scoring.ts";

const SLUG = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/);
const HTTPS_URL = z.url({ protocol: /^https$/ });

export const topicSchema = z.strictObject({
  slug: SLUG,
  name: z.string().min(1),
  keywords: z.array(z.string().min(2)).min(1),
  enabled: z.boolean().default(true),
});

const sourceBase = {
  label: z.string().min(1),
  topicHint: SLUG.optional(),
  authorKey: SLUG.optional(),
  priority: z.int().min(1).max(9).default(5),
  pollIntervalMin: z.int().min(30).max(1440),
  alwaysPass: z.boolean().default(false),
  enabled: z.boolean().default(true),
};

export const sourceSchema = z.discriminatedUnion("type", [
  // key: X handle without the leading @
  z.strictObject({ type: z.literal("x"), key: z.string().regex(X_HANDLE_PATTERN), ...sourceBase }),
  // key: Algolia search query
  z.strictObject({ type: z.literal("hn"), key: z.string().min(1).max(100), ...sourceBase }),
  // key: feed URL
  z.strictObject({ type: z.literal("rss"), key: HTTPS_URL, ...sourceBase }),
  // key: "owner/repo" for releases, or "search:<query>" for the trending proxy
  z.strictObject({
    type: z.literal("github"),
    key: z.string().regex(/^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+|search:.{1,120}|trending:daily)$/),
    ...sourceBase,
  }),
]);

export const authorSchema = z.strictObject({
  authorKey: SLUG,
  name: z.string().min(1),
  handles: z
    .array(z.strictObject({ platform: z.enum(PLATFORMS), handle: z.string().min(1) }))
    .min(1),
});

export const settingsSchema = z.strictObject({
  display_min_score: z.number().min(0).max(100),
  synthesis_min_score: z.number().min(0).max(100),
  synthesis_reserved_share: z.number().min(0).max(1),
  backfill_max_share: z.number().min(0).max(1),
  display_timezone: z.string().min(1),
  llm_safe_default_rpm: z.int().min(1),
  llm_safe_default_rpd: z.int().min(1),
  filter_languages: z.array(z.string().length(2)).min(1),
  filter_min_text_length: z.int().min(1),
  hn_min_points: z.int().min(0),
  // Overrides for algorithm parameters owned by packages/core/src/params.ts.
  core_overrides: z.record(z.string(), z.unknown()),
  editorial_scoring: editorialScoringSchema.optional(),
});

export const stopEntitiesSchema = z.array(z.string().min(1)).min(1);

export type TopicConfig = z.infer<typeof topicSchema>;
export type SourceConfig = z.infer<typeof sourceSchema>;
export type AuthorConfig = z.infer<typeof authorSchema>;
export type SettingsConfig = z.infer<typeof settingsSchema>;
