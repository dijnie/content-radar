import { providerUrl } from "./api-url";

export type LlmErrorKind = "rate_limited" | "configuration_error" | "insufficient_balance" | "invalid_request" | "invalid_output" | "transient";

export interface LlmRequest {
  apiKey?: string;
  model: string;
  system: string;
  user: string;
  schema: Record<string, unknown>;
  /** OpenAI-compatible API base URL or full chat/completions URL. */
  endpoint: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
}

interface Usage { tokensIn: number; tokensOut: number }
export type LlmResult =
  | ({ ok: true; data: unknown; httpStatus: number; latencyMs: number } & Usage)
  | ({ ok: false; kind: LlmErrorKind; reached: boolean; httpStatus: number | null; latencyMs: number; message: string; retryDelaySeconds?: number } & Usage);

export const MAX_OUTPUT_TOKENS = 8192;

export function retryAfterSeconds(value: string | null, nowMs = Date.now()): number {
  if (!value?.trim()) return 60;
  const numeric = Number(value);
  const seconds = Number.isFinite(numeric) ? numeric : (Date.parse(value) - nowMs) / 1000;
  return Number.isFinite(seconds) ? Math.max(1, Math.min(300, Math.ceil(seconds))) : 60;
}

/** Read a complete JSON object. Callers validate task schemas and evidence quotes. */
export async function generateJson(request: LlmRequest): Promise<LlmResult> {
  const started = Date.now();
  let status: number | null = null;
  let usage: Usage = { tokensIn: 0, tokensOut: 0 };
  const fail = (kind: LlmErrorKind, reached: boolean, message: string): Extract<LlmResult, { ok: false }> => ({
    ok: false, kind, reached, httpStatus: status, latencyMs: Date.now() - started, message, ...usage,
  });
  let endpoint: URL;
  if (!request.endpoint.trim()) return fail("configuration_error", false, "llm_endpoint_missing");
  try {
    endpoint = providerUrl(request.endpoint, "chat/completions");
  } catch {
    return fail("configuration_error", false, "llm_endpoint_invalid");
  }
  if (!request.apiKey?.trim()) return fail("configuration_error", false, "llm_api_key_missing");
  if (!request.model.trim()) return fail("configuration_error", false, "llm_model_missing");

  let response: Response;
  let raw: string;
  try {
    const input = {
      messages: [
        { role: "system", content: `${request.system}\n\nReturn only a JSON object conforming to this JSON Schema:\n${JSON.stringify(request.schema)}` },
        { role: "user", content: request.user },
      ],
      response_format: { type: "json_object" },
      temperature: 0, max_tokens: MAX_OUTPUT_TOKENS, stream: false,
    };
    const deadline = AbortSignal.timeout(request.timeoutMs ?? 60_000);
    const signal = request.signal ? AbortSignal.any([deadline, request.signal]) : deadline;
    signal.throwIfAborted();
    response = await (request.fetcher ?? fetch)(endpoint.toString(), {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${request.apiKey.trim()}` },
      // Workers supports manual/follow redirects. Never follow a provider
      // redirect, which could forward the API key to another destination.
      body: JSON.stringify({ model: request.model.trim(), ...input }), signal, redirect: "manual",
    });
    status = response.status;
    if (status >= 300 && status < 400) {
      await response.body?.cancel();
      return fail("configuration_error", true, "llm_redirect_disallowed");
    }
    // Providers may send keep-alive newlines before the JSON body. The timeout
    // covers body consumption as well as waiting for the response headers.
    raw = await response.text();
  } catch (err) {
    return fail("transient", status !== null, err instanceof Error ? err.name : "network_error");
  }
  if (status === 401 || status === 403 || status === 404) return fail("configuration_error", true, `llm_http_${status}`);
  if (status === 402) return fail("insufficient_balance", true, "llm_insufficient_balance");
  if (status === 429) return { ...fail("rate_limited", true, "llm_rate_limited"), retryDelaySeconds: retryAfterSeconds(response.headers.get("Retry-After")) };
  if (status >= 500 || status === 408) return fail("transient", true, `llm_http_${status}`);
  if (!response.ok) return fail("invalid_request", true, `llm_http_${status}`);

  let body: {
    choices?: { message?: { content?: unknown }; finish_reason?: string }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  } | null;
  try {
    body = JSON.parse(raw);
  } catch {
    return fail("invalid_output", true, "llm_invalid_response_json");
  }
  usage = { tokensIn: body?.usage?.prompt_tokens ?? 0, tokensOut: body?.usage?.completion_tokens ?? 0 };
  const choice = body?.choices?.[0];
  if (choice?.finish_reason === "length") return fail("invalid_output", true, "llm_output_limit");
  if (choice?.finish_reason !== "stop") return fail("invalid_output", true, "llm_incomplete_response");
  const content = choice.message?.content;
  if (content != null && typeof content !== "string") return fail("invalid_output", true, "llm_unexpected_content_type");
  const text = content?.trim();
  if (!text) return fail("invalid_output", true, "llm_empty_response");

  // Some compatible providers wrap even a JSON-mode answer in a single Markdown block.
  const fenced = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i.exec(text);
  let data: unknown;
  try {
    data = JSON.parse(fenced ? fenced[1]! : text);
  } catch {
    return fail("invalid_output", true, "llm_invalid_content_json");
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) return fail("invalid_output", true, "llm_expected_object");
  return { ok: true, data, httpStatus: status, latencyMs: Date.now() - started, ...usage };
}
