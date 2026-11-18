import { z } from "zod";
import { nowSeconds } from "../db/batch";
import type { Env } from "../env";
import { nextPacificMidnight, pacificDay } from "../llm/pacific-day";
import { jsonError } from "./api-errors";

const params = z.object({
  model: z.string().min(1).max(2048),
  before: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
});
const PAGE_SIZE = 30;

export async function handleLlmCalls(request: Request, env: Pick<Env, "DB">, now = nowSeconds()) {
  const query = params.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!query.success) return jsonError(400, "invalid_call_log_filters");
  const end = nextPacificMidnight(now);
  // Noon on the previous Pacific day stays on that day across DST changes.
  const start = nextPacificMidnight(end - 36 * 3600);
  const rows = await env.DB.prepare(`SELECT id, at, kind,
      CASE WHEN status = 'running' AND at < ? THEN 'no_final_result' ELSE status END AS status,
      http_status AS httpStatus, latency_ms AS latencyMs,
      tokens_in AS tokensIn, tokens_out AS tokensOut,
      CASE WHEN json_valid(item_ids_json) THEN json_array_length(item_ids_json) END AS subjects, claims_accepted AS claimsAccepted,
      CASE WHEN error IN ('TimeoutError', 'AbortError', 'llm_output_limit', 'llm_invalid_json',
        'llm_incomplete_response', 'llm_empty_response', 'llm_redirect_disallowed') THEN error END AS reason
    FROM llm_calls WHERE model = ? AND at >= ? AND at < ? AND id < ?
    ORDER BY id DESC LIMIT ?`)
    .bind(now - 15 * 60, query.data.model, start, end, query.data.before ?? Number.MAX_SAFE_INTEGER, PAGE_SIZE + 1)
    .all<{ id: number }>();
  const calls = rows.results.slice(0, PAGE_SIZE);
  return Response.json({ calls, day: pacificDay(now), nextBefore: rows.results.length > PAGE_SIZE ? calls.at(-1)!.id : null },
    { headers: { "Cache-Control": "no-store" } });
}
