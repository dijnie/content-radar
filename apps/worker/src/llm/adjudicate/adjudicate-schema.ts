import { z } from "zod";

export const ADJUDICATION_DECISIONS = ["same", "version_of", "different"] as const;

export const adjudicateResponseSchema = z.object({
  decisions: z.array(z.object({ id: z.number().int(), decision: z.enum(ADJUDICATION_DECISIONS) })),
});

export const ADJUDICATE_JSON_SCHEMA = {
  type: "object",
  required: ["decisions"],
  properties: {
    decisions: { type: "array", items: { type: "object", required: ["id", "decision"], properties: { id: { type: "integer" }, decision: { type: "string", enum: ADJUDICATION_DECISIONS } } } },
  },
} as const;
