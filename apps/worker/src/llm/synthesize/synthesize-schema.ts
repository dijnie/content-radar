import { z } from "zod";

export const HEADLINE_MAX_LENGTH = 220;

export const STORY_ROLES = ["evidence", "context", "counter"] as const;

export const synthesizeResponseSchema = z.object({
  headline_vi: z.string().trim().min(12).max(HEADLINE_MAX_LENGTH),
  roles: z.array(z.object({ claimId: z.number().int(), role: z.enum(STORY_ROLES) })).default([]),
  questions: z.array(z.string().trim().min(8).max(240)).default([]),
});

export const SYNTHESIZE_JSON_SCHEMA = {
  type: "object",
  required: ["headline_vi", "roles", "questions"],
  properties: {
    headline_vi: { type: "string", minLength: 12, maxLength: HEADLINE_MAX_LENGTH },
    roles: { type: "array", items: { type: "object", required: ["claimId", "role"], properties: { claimId: { type: "integer" }, role: { type: "string", enum: STORY_ROLES } } } },
    questions: { type: "array", items: { type: "string", minLength: 8, maxLength: 240 } },
  },
} as const;
