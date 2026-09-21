export type LlmErrorKind = "rate_limited" | "configuration_error" | "insufficient_balance" | "invalid_request" | "invalid_output" | "transient";

export interface LlmRequest {
  apiKey?: string;
  model: string;
  system: string;
  user: string;
  schema: Record<string, unknown>;
  baseUrl?: string;
  ai?: Pick<Ai, "run">;
  gatewayId?: string;
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
  const baseUrl = (request.baseUrl ?? DEFAULT_DEEPSEEK_BASE_URL).replace(/\/+$/, "");
  const gateway = request.gatewayId !== undefined;
  if (gateway) {
    if (!/^[a-z0-9_]+(?:-[a-z0-9_]+)*$/.test(request.gatewayId!)) return fail("configuration_error", false, "deepseek_gateway_id_invalid");
    if (!request.ai) return fail("configuration_error", false, "deepseek_ai_binding_missing");
  } else {
    try {
      if (new URL(baseUrl).hostname === "gateway.ai.cloudflare.com") return fail("configuration_error", false, "deepseek_gateway_id_required");
    } catch {
      return fail("configuration_error", false, "deepseek_base_url_invalid");
    }
    if (!request.apiKey?.trim()) return fail("configuration_error", false, "deepseek_api_key_missing");
  }
  // During rollout the database may still select the previous provider's models.
  if (!request.model.startsWith("deepseek-")) return fail("configuration_error", false, "deepseek_model_not_configured");

  let response: Response;
  let raw: string;
  try {
    const input = {
      messages: [
        { role: "system", content: `${request.system}\n\nReturn only a JSON object conforming to this JSON Schema:\n${JSON.stringify(request.schema)}` },
        { role: "user", content: request.user },
      ],
      response_format: { type: "json_object" }, thinking: { type: "disabled" },
      temperature: 0, max_tokens: MAX_OUTPUT_TOKENS, stream: false,
    };
    const signal = AbortSignal.timeout(request.timeoutMs ?? 60_000);
    if (gateway) {
      // Raw responses preserve HTTP status, Retry-After and provider usage for
      // the application ledger. The Gateway must require BYOK credentials.
      const result = await request.ai!.run(`deepseek/${request.model}`, input, {
        returnRawResponse: true, signal, extraHeaders: { "cf-aig-no-wholesale": "true" },
        gateway: { id: request.gatewayId!, skipCache: true, retries: { maxAttempts: 1 }, metadata: { application: "content-radar" } },
      });
      if (!(result instanceof Response)) return fail("configuration_error", true, "deepseek_raw_response_required");
      response = result;
    } else {
      response = await (request.fetcher ?? fetch)(`${baseUrl}/chat/completions`, {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${request.apiKey}` },
        body: JSON.stringify({ model: request.model, ...input }), signal,
      });
    }
    status = response.status;
    // DeepSeek may send keep-alive newlines before the JSON body. The timeout
    // covers body consumption as well as waiting for the response headers.
    raw = await response.text();
  } catch (err) {
    return fail("transient", status !== null, err instanceof Error ? err.name : "network_error");
  }
  // Gateway rejects missing BYOK credentials with 400. Preserve queued work
  // while its binding/provider configuration is repaired.
  if (gateway && status === 400) return fail("configuration_error", true, "deepseek_gateway_request_rejected");
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
