import { z } from "zod";

export const STORY_ROLES = ["evidence", "context", "counter"] as const;

export const synthesizeResponseSchema = z.object({
  headline_vi: z.string().trim().min(12).max(220),
  roles: z.array(z.object({ claimId: z.number().int(), role: z.enum(STORY_ROLES) })).default([]),
  questions: z.array(z.string().trim().min(8).max(240)).default([]),
});

export const SYNTHESIZE_JSON_SCHEMA = {
  type: "object",
  required: ["headline_vi", "roles", "questions"],
  properties: {
    headline_vi: { type: "string" },
    roles: { type: "array", items: { type: "object", required: ["claimId", "role"], properties: { claimId: { type: "integer" }, role: { type: "string", enum: STORY_ROLES } } } },
    questions: { type: "array", items: { type: "string" } },
  },
} as const;
