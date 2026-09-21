export type GeminiErrorKind = "rate_limited" | "location_blocked" | "invalid_request" | "transient";

export interface GeminiRequest {
  apiKey: string;
  model: string;
  system: string;
  user: string;
  /** JSON Schema for `responseJsonSchema`; kept flat and small on purpose. */
  schema: Record<string, unknown>;
  /** Base URL up to and including the API version; an AI Gateway URL can replace it. */
  baseUrl?: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
}

/** What a 429 says about itself. Google names the exhausted quota and how long to wait. */
export interface QuotaInfo {
  scope: "minute" | "day" | "unknown";
  /** The limit Google enforces for that quota, when it states one. */
  limit: number | null;
  retryDelaySeconds: number | null;
}

export type GeminiResult =
  | { ok: true; data: unknown; httpStatus: number; latencyMs: number; tokensIn: number; tokensOut: number }
  | {
      ok: false;
      kind: GeminiErrorKind;
      /** Whether the request counted against Google's quota, which decides commit versus release. */
      reached: boolean;
      httpStatus: number | null;
      latencyMs: number;
      message: string;
      /** Present on `rate_limited` results. */
      quota?: QuotaInfo;
    };

export const DEFAULT_GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

interface ErrorDetail {
  "@type"?: string;
  violations?: { quotaId?: string; quotaValue?: string | number }[];
  retryDelay?: string;
}

/**
 * Reads the quota a 429 refers to. The free tier has both per-minute and per-day request
 * quotas, and they call for opposite reactions: seconds of patience versus parking the
 * model until the daily reset. The quota id says which one it was, e.g.
 * `GenerateRequestsPerDayPerProjectPerModel-FreeTier`.
 */
export function parseQuota(body: unknown): QuotaInfo {
  const details = ((body as { error?: { details?: ErrorDetail[] } })?.error?.details ?? []) as ErrorDetail[];
  const violations = details.flatMap((detail) => detail.violations ?? []);
  // A per-day violation outranks a per-minute one reported alongside it.
  const violation = violations.find((entry) => /PerDay/i.test(entry.quotaId ?? "")) ?? violations.find((entry) => /PerMinute/i.test(entry.quotaId ?? "")) ?? null;
  const scope = !violation ? "unknown" : /PerDay/i.test(violation.quotaId ?? "") ? "day" : "minute";
  const limit = violation?.quotaValue === undefined ? NaN : Number(violation.quotaValue);
  const delay = /^(\d+(?:\.\d+)?)s$/.exec(details.find((detail) => detail.retryDelay)?.retryDelay ?? "");
  return { scope, limit: Number.isFinite(limit) && limit > 0 ? limit : null, retryDelaySeconds: delay ? Math.ceil(Number(delay[1])) : null };
}

interface GenerateContentResponse {
  candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  error?: { code?: number; message?: string; status?: string };
}

/**
 * The pipeline's only way to Gemini, always called through budgetedCall. The one other caller is the manual
 * diagnostic probe in api/admin-probe.ts, which spends one unbudgeted request per click. Never logs the key or a header.
 */
export async function generateJson(request: GeminiRequest): Promise<GeminiResult> {
  const started = Date.now();
  const elapsed = () => Date.now() - started;
  const url = `${request.baseUrl ?? DEFAULT_GEMINI_BASE_URL}/models/${encodeURIComponent(request.model)}:generateContent`;

  let response: Response;
  try {
    response = await (request.fetcher ?? fetch)(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": request.apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: request.system }] },
        contents: [{ role: "user", parts: [{ text: request.user }] }],
        generationConfig: { responseMimeType: "application/json", responseJsonSchema: request.schema, temperature: 0 },
      }),
      signal: AbortSignal.timeout(request.timeoutMs ?? 60_000),
    });
  } catch (err) {
    return { ok: false, kind: "transient", reached: false, httpStatus: null, latencyMs: elapsed(), message: err instanceof Error ? err.name : "network_error" };
  }

  const raw = await response.text().catch(() => "");
  let body: GenerateContentResponse = {};
  try {
    body = JSON.parse(raw) as GenerateContentResponse;
  } catch {
    // A non-JSON body is handled by the status checks below.
  }
  const fail = (kind: GeminiErrorKind, reached: boolean, message: string): GeminiResult => ({
    ok: false, kind, reached, httpStatus: response.status, latencyMs: elapsed(), message: message.slice(0, 300),
  });
  const upstreamMessage = body.error?.message ?? `http_${response.status}`;

  if (response.status === 429) return { ...fail("rate_limited", true, upstreamMessage), quota: parseQuota(body) } as GeminiResult;
  // Refused for the egress location before any quota is charged.
  if (upstreamMessage.includes("User location is not supported")) return fail("location_blocked", false, upstreamMessage);
  if (response.status >= 500) return fail("transient", false, upstreamMessage);
  if (!response.ok) return fail("invalid_request", true, upstreamMessage);

  const candidate = body.candidates?.[0];
  const text = candidate?.content?.parts?.map((part) => part.text ?? "").join("") ?? "";
  const usage = { tokensIn: body.usageMetadata?.promptTokenCount ?? 0, tokensOut: body.usageMetadata?.candidatesTokenCount ?? 0 };
  try {
    if (!text) throw new Error(`empty_response:${candidate?.finishReason ?? "unknown"}`);
    return { ok: true, data: JSON.parse(text) as unknown, httpStatus: response.status, latencyMs: elapsed(), ...usage };
  } catch (err) {
    // Gemini answered and charged the quota, but the output is unusable.
    return fail("invalid_request", true, err instanceof Error ? err.message : "unparseable_response");
  }
}
