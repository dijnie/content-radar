import { z } from "zod";

export const EDITORIAL_CATEGORIES = ["news", "tool", "field_test", "playbook", "deep_dive", "other"] as const;
export const EDITORIAL_PILLARS = ["architecture", "agents", "evaluation", "training", "inference", "data", "infrastructure", "security", "tooling", "other"] as const;
export const editorialSchema = z.object({
  category: z.enum(EDITORIAL_CATEGORIES),
  pillar: z.enum(EDITORIAL_PILLARS),
  summary_vi: z.string().trim().min(10).max(2000),
  question_vi: z.string().trim().min(5).max(500).nullable(),
});
export type Editorial = z.infer<typeof editorialSchema>;
export const EDITORIAL_JSON_SCHEMA = {
  type: "object", required: ["category", "pillar", "summary_vi", "question_vi"],
  properties: {
    category: { type: "string", enum: EDITORIAL_CATEGORIES }, pillar: { type: "string", enum: EDITORIAL_PILLARS },
    summary_vi: { type: "string" }, question_vi: { type: ["string", "null"] },
  },
};
