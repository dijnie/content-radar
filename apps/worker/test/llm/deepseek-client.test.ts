import { describe, expect, it, vi } from "vitest";
import { generateJson, MAX_OUTPUT_TOKENS, retryAfterSeconds, type LlmRequest } from "../../src/llm/deepseek-client";
import envelope from "../fixtures/deepseek/success-envelope.json";

const request: LlmRequest = { apiKey: "test-key", model: "deepseek-flash", system: 'Return JSON. Example: {"ok":true}', user: "check", schema: { type: "object" } };
const answer = (content = '{"ok":true}', finishReason = "stop") => ({ ...envelope, choices: [{ message: { content }, finish_reason: finishReason }] });

describe("DeepSeek JSON transport", () => {
  it("uses the documented chat contract, disables thinking and preserves token usage", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(`\n\n${JSON.stringify(answer())}`));
    const result = await generateJson({ ...request, fetcher });
    expect(result).toMatchObject({ ok: true, data: { ok: true }, tokensIn: 1840, tokensOut: 412 });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://api.deepseek.com/chat/completions");
    expect(init?.headers).toMatchObject({ Authorization: "Bearer test-key" });
    expect(JSON.parse(String(init?.body))).toEqual({
      model: "deepseek-flash", messages: [{ role: "system", content: expect.stringContaining('JSON Schema:\n{"type":"object"}') }, { role: "user", content: "check" }],
      response_format: { type: "json_object" }, thinking: { type: "disabled" }, temperature: 0, max_tokens: MAX_OUTPUT_TOKENS, stream: false,
    });
  });

  it.each([{ apiKey: "" }, { model: "gemini-3.8-flash" }])("rejects rollout configuration before HTTP: %j", async (override) => {
    const fetcher = vi.fn<typeof fetch>();
    expect(await generateJson({ ...request, ...override, fetcher })).toMatchObject({ ok: false, kind: "configuration_error", reached: false });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([[401, "configuration_error"], [403, "configuration_error"], [404, "configuration_error"], [402, "insufficient_balance"], [422, "invalid_request"], [500, "transient"], [503, "transient"]])("classifies HTTP %i without logging provider bodies", async (status, kind) => {
    const result = await generateJson({ ...request, fetcher: (async () => Response.json({ error: "sensitive-provider-detail" }, { status: Number(status) })) as typeof fetch });
    expect(result).toMatchObject({ ok: false, kind, reached: true, httpStatus: status });
    expect(JSON.stringify(result)).not.toContain("sensitive-provider-detail");
  });

  it("honors a bounded Retry-After without inventing a daily quota", async () => {
    expect(await generateJson({ ...request, fetcher: (async () => new Response("", { status: 429, headers: { "Retry-After": "23" } })) as typeof fetch })).toMatchObject({ ok: false, kind: "rate_limited", retryDelaySeconds: 23 });
    const now = Date.UTC(2026, 8, 21);
    expect(retryAfterSeconds(new Date(now + 90_000).toUTCString(), now)).toBe(90);
    expect(retryAfterSeconds("86400")).toBe(300);
    expect(retryAfterSeconds("-2")).toBe(1);
    expect(retryAfterSeconds("unknown")).toBe(60);
  });

  it.each([["", "stop"], ["not json", "stop"], ["null", "stop"], ["[]", "stop"], ['{"ok":true}', "length"]])("rejects empty, malformed or truncated output (%s, %s), retaining usage", async (content, reason) => {
    const result = await generateJson({ ...request, fetcher: (async () => Response.json(answer(content, reason))) as typeof fetch });
    expect(result).toMatchObject({ ok: false, kind: "invalid_output", reached: true, tokensIn: 1840, tokensOut: 412 });
  });

  it("times out while reading a keep-alive body", async () => {
    const fetcher = (async (_url: RequestInfo | URL, init?: RequestInit) => new Response(new ReadableStream({
      start(controller) { init!.signal!.addEventListener("abort", () => controller.error(new DOMException("timed out", "TimeoutError"))); },
    }))) as typeof fetch;
    expect(await generateJson({ ...request, fetcher, timeoutMs: 5 })).toMatchObject({ ok: false, kind: "transient", reached: true, httpStatus: 200 });
  });
});
