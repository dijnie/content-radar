import { z } from "zod";
import { nowSeconds } from "../db/batch";
import type { Env } from "../env";
import { nextPacificMidnight, pacificDay } from "../llm/pacific-day";
import { NEEDS_SYNTHESIS, RETRYABLE_ITEM_FAILURE } from "../llm/retry-eligibility";
import { jsonError } from "./api-errors";

const params = z.object({
  model: z.string().min(1).max(2048),
  filter: z.enum(["all", "active", "failed"]).default("all"),
  before: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
});
const PAGE_SIZE = 30;

export async function handleLlmCalls(request: Request, env: Pick<Env, "DB">, now = nowSeconds()) {
  const query = params.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!query.success) return jsonError(400, "invalid_call_log_filters");
  const end = nextPacificMidnight(now);
  // Noon on the previous Pacific day stays on that day across DST changes.
  const start = nextPacificMidnight(end - 36 * 3600);
  const filter = query.data.filter === "active" ? "WHERE status IN ('running','processing')"
    : query.data.filter === "failed" ? "WHERE status NOT IN ('running','processing','ok','stopped')" : "";
  const rows = await env.DB.prepare(`WITH calls AS (SELECT id, at, kind, item_ids_json,
      CASE WHEN status IN ('running','processing') AND at < ? THEN 'no_final_result' ELSE status END AS status,
      http_status AS httpStatus, latency_ms AS latencyMs,
      tokens_in AS tokensIn, tokens_out AS tokensOut,
      CASE WHEN json_valid(item_ids_json) THEN json_array_length(item_ids_json) END AS subjects, claims_accepted AS claimsAccepted,
      CASE WHEN error IN ('TimeoutError', 'AbortError', 'llm_output_limit', 'llm_invalid_json',
        'llm_invalid_response_json', 'llm_invalid_content_json', 'llm_unexpected_content_type',
        'llm_expected_object', 'llm_incomplete_response', 'llm_empty_response', 'llm_redirect_disallowed') THEN error END AS reason
    FROM llm_calls WHERE model = ? AND at >= ? AND at < ? AND id < ?),
    page AS (SELECT * FROM calls ${filter} ORDER BY id DESC LIMIT ?)
    SELECT id, at, kind, status, httpStatus, latencyMs, tokensIn, tokensOut, subjects, claimsAccepted, reason,
      CASE WHEN status IN ('ok','running','processing') OR NOT COALESCE(json_valid(item_ids_json),0) THEN 0
        WHEN kind = 'synthesize' THEN EXISTS (SELECT 1 FROM json_each(page.item_ids_json) j
          JOIN stories subject ON subject.id = j.value WHERE ${NEEDS_SYNTHESIS})
        WHEN kind = 'adjudicate' THEN EXISTS (SELECT 1 FROM json_each(page.item_ids_json) j
          JOIN entity_adjudications subject ON subject.id = j.value WHERE subject.status != 'decided')
        ELSE EXISTS (SELECT 1 FROM json_each(page.item_ids_json) j JOIN items subject ON subject.id = j.value
          WHERE subject.status = 'queued' OR (subject.status = 'failed' AND ${RETRYABLE_ITEM_FAILURE})) END AS retryable
    FROM page ORDER BY id DESC`)
    .bind(now - 15 * 60, query.data.model, start, end, query.data.before ?? Number.MAX_SAFE_INTEGER, PAGE_SIZE + 1)
    .all<{ id: number }>();
  const calls = rows.results.slice(0, PAGE_SIZE);
  return Response.json({ calls, day: pacificDay(now), nextBefore: rows.results.length > PAGE_SIZE ? calls.at(-1)!.id : null },
    { headers: { "Cache-Control": "no-store" } });
}
