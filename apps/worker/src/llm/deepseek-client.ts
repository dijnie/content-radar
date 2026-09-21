export type LlmErrorKind = "rate_limited" | "configuration_error" | "insufficient_balance" | "invalid_request" | "invalid_output" | "transient";

export interface LlmRequest {
  apiKey: string;
  model: string;
  system: string;
  user: string;
  schema: Record<string, unknown>;
  baseUrl?: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
}

interface Usage { tokensIn: number; tokensOut: number }
export type LlmResult =
  | ({ ok: true; data: unknown; httpStatus: number; latencyMs: number } & Usage)
  | ({ ok: false; kind: LlmErrorKind; reached: boolean; httpStatus: number | null; latencyMs: number; message: string; retryDelaySeconds?: number } & Usage);

export const DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com";
export const DEFAULT_DEEPSEEK_MODEL = "deepseek-flash";
export const MAX_OUTPUT_TOKENS = 8192;

export function retryAfterSeconds(value: string | null, nowMs = Date.now()): number {
  if (!value?.trim()) return 60;
  const numeric = Number(value);
  const seconds = Number.isFinite(numeric) ? numeric : (Date.parse(value) - nowMs) / 1000;
  return Number.isFinite(seconds) ? Math.max(1, Math.min(300, Math.ceil(seconds))) : 60;
}

/** JSON mode guarantees JSON syntax only; callers still validate schemas and evidence quotes. */
export async function generateJson(request: LlmRequest): Promise<LlmResult> {
  const started = Date.now();
  let status: number | null = null;
  let usage: Usage = { tokensIn: 0, tokensOut: 0 };
  const fail = (kind: LlmErrorKind, reached: boolean, message: string): Extract<LlmResult, { ok: false }> => ({
    ok: false, kind, reached, httpStatus: status, latencyMs: Date.now() - started, message, ...usage,
  });
  if (!request.apiKey?.trim()) return fail("configuration_error", false, "deepseek_api_key_missing");
  // During rollout the database may still select the previous provider's models.
  if (!request.model.startsWith("deepseek-")) return fail("configuration_error", false, "deepseek_model_not_configured");

  let response: Response;
  let raw: string;
  try {
    response = await (request.fetcher ?? fetch)(`${(request.baseUrl ?? DEFAULT_DEEPSEEK_BASE_URL).replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${request.apiKey}` },
      body: JSON.stringify({
        model: request.model,
        messages: [
          { role: "system", content: `${request.system}\n\nReturn only a JSON object conforming to this JSON Schema:\n${JSON.stringify(request.schema)}` },
          { role: "user", content: request.user },
        ],
        response_format: { type: "json_object" }, thinking: { type: "disabled" },
        temperature: 0, max_tokens: MAX_OUTPUT_TOKENS, stream: false,
      }),
      signal: AbortSignal.timeout(request.timeoutMs ?? 60_000),
    });
    status = response.status;
    // DeepSeek may send keep-alive newlines before the JSON body. The timeout
    // covers body consumption as well as waiting for the response headers.
    raw = await response.text();
  } catch (err) {
    return fail("transient", status !== null, err instanceof Error ? err.name : "network_error");
  }
  if (status === 401 || status === 403 || status === 404) return fail("configuration_error", true, `deepseek_http_${status}`);
  if (status === 402) return fail("insufficient_balance", true, "deepseek_insufficient_balance");
  if (status === 429) return { ...fail("rate_limited", true, "deepseek_rate_limited"), retryDelaySeconds: retryAfterSeconds(response.headers.get("Retry-After")) };
  if (status >= 500 || status === 408) return fail("transient", true, `deepseek_http_${status}`);
  if (!response.ok) return fail("invalid_request", true, `deepseek_http_${status}`);

  try {
    const body = JSON.parse(raw) as {
      choices?: { message?: { content?: string | null }; finish_reason?: string }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    usage = { tokensIn: body.usage?.prompt_tokens ?? 0, tokensOut: body.usage?.completion_tokens ?? 0 };
    const choice = body.choices?.[0];
    if (choice?.finish_reason !== "stop") return fail("invalid_output", true, "deepseek_incomplete_response");
    if (!choice.message?.content?.trim()) return fail("invalid_output", true, "deepseek_empty_response");
    const data: unknown = JSON.parse(choice.message.content);
    if (data === null || typeof data !== "object" || Array.isArray(data)) return fail("invalid_output", true, "deepseek_expected_object");
    return { ok: true, data, httpStatus: status, latencyMs: Date.now() - started, ...usage };
  } catch {
    return fail("invalid_output", true, "deepseek_invalid_json");
  }
}
