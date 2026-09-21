import { z } from "zod";
import { EDITORIAL_JSON_SCHEMA } from "./editorial-schema";

export const CLAIM_KINDS = ["measurement", "experience", "announcement", "report", "opinion"] as const;
export const ENTITY_TYPES = ["org", "person", "product", "model", "paper", "repo", "concept", "other"] as const;
export const QUOTE_MAX_LENGTH = 300;

const entitySchema = z.object({ surface: z.string().trim().min(1).max(120), type: z.enum(ENTITY_TYPES).catch("other") });

const claimSchema = z.object({
  kind: z.enum(CLAIM_KINDS),
  text_vi: z.string().trim().min(10).max(600),
  text_en: z.string().trim().min(10).max(600),
  quote: z.string().trim().min(8),
  has_numbers: z.boolean(),
  first_hand: z.boolean(),
  entities: z.array(entitySchema).max(12).default([]),
});

const itemSchema = z.object({
  itemId: z.number().int(),
  relevant: z.boolean(),
  topics: z.array(z.string()).max(3).default([]),
  // One malformed claim must not cost the item its valid ones.
  claims: z.array(z.unknown()).max(12).default([]),
  editorial: z.unknown().optional(),
});

export const extractResponseSchema = z.object({ items: z.array(itemSchema) });
export type ExtractedClaim = z.infer<typeof claimSchema>;
export type ExtractedItem = z.infer<typeof itemSchema>;

export function parseClaim(value: unknown): ExtractedClaim | null {
  const result = claimSchema.safeParse(value);
  return result.success ? result.data : null;
}

/** JSON Schema supplied as prompt guidance; the response is validated locally. */
export const EXTRACT_JSON_SCHEMA = {
  type: "object",
  required: ["items"],
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        required: ["itemId", "relevant", "topics", "claims"],
        properties: {
          itemId: { type: "integer" },
          relevant: { type: "boolean" },
          topics: { type: "array", items: { type: "string" } },
          editorial: EDITORIAL_JSON_SCHEMA,
          claims: {
            type: "array",
            items: {
              type: "object",
              required: ["kind", "text_vi", "text_en", "quote", "has_numbers", "first_hand", "entities"],
              properties: {
                kind: { type: "string", enum: CLAIM_KINDS },
                text_vi: { type: "string" },
                text_en: { type: "string" },
                quote: { type: "string" },
                has_numbers: { type: "boolean" },
                first_hand: { type: "boolean" },
                entities: {
                  type: "array",
                  items: {
                    type: "object",
                    required: ["surface", "type"],
                    properties: { surface: { type: "string" }, type: { type: "string", enum: ENTITY_TYPES } },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
} as const;
