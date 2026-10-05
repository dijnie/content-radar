import { describe, expect, it, vi } from "vitest";
import { generateJson, MAX_OUTPUT_TOKENS, retryAfterSeconds, type LlmRequest } from "../../src/llm/custom-client";
import envelope from "../fixtures/deepseek/success-envelope.json";

const request: LlmRequest = { endpoint: "https://llm.example/v1", apiKey: "test-key", model: "vendor/custom-model", system: 'Return JSON. Example: {"ok":true}', user: "check", schema: { type: "object" } };
const answer = (content = '{"ok":true}', finishReason = "stop") => ({ ...envelope, choices: [{ message: { content }, finish_reason: finishReason }] });
describe("custom OpenAI-compatible JSON transport", () => {
  it.each([
    ["https://llm.example/v1", "https://llm.example/v1/chat/completions"],
    ["https://llm.example/v1/", "https://llm.example/v1/chat/completions"],
    ["https://llm.example/v1/chat/completions", "https://llm.example/v1/chat/completions"],
    ["https://llm.example/v1/chat/completions/", "https://llm.example/v1/chat/completions"],
    ["https://llm.example", "https://llm.example/chat/completions"],
    ["http://localhost:8000/v1", "http://localhost:8000/v1/chat/completions"],
    ["https://llm.example/proxy/v1?version=1", "https://llm.example/proxy/v1/chat/completions?version=1"],
    ["  https://llm.example/v1  ", "https://llm.example/v1/chat/completions"],
  ])("resolves endpoint %s", async (endpoint, expected) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(answer()));
    expect(await generateJson({ ...request, endpoint, fetcher })).toMatchObject({ ok: true });
    expect(fetcher).toHaveBeenCalledWith(expected, expect.objectContaining({ method: "POST", redirect: "manual" }));
  });

  it("constructs a request accepted by the Workers runtime", async () => {
    const fetcher: typeof fetch = async (input, init) => {
      // Use the real Workers Request constructor: a stub alone misses
      // unsupported fetch options, including redirect: "error".
      const outgoing = new Request(input, init);
      expect(outgoing.redirect).toBe("manual");
      return Response.json(answer());
    };
    expect(await generateJson({ ...request, fetcher })).toMatchObject({ ok: true, data: { ok: true } });
  });

  it.each([301, 302, 303, 307, 308])("rejects HTTP %i without following or exposing the redirect", async (status) => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const outgoing = new Request(input, init);
      expect(outgoing.redirect).toBe("manual");
      return new Response("private provider detail", { status, headers: { Location: "https://other.example/private" } });
    });
    const result = await generateJson({ ...request, fetcher });
    expect(result).toMatchObject({ ok: false, kind: "configuration_error", reached: true, httpStatus: status, message: "llm_redirect_disallowed" });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toMatch(/other\.example|private provider detail/);
  });

  it.each(["", "  ", "not-a-url", "ftp://llm.example", "https://user:secret@llm.example/v1", "https://llm.example/v1#fragment"])("rejects invalid endpoint before sending credentials: %s", async (endpoint) => {
    const fetcher = vi.fn<typeof fetch>();
    expect(await generateJson({ ...request, endpoint, fetcher })).toMatchObject({ ok: false, kind: "configuration_error", reached: false });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("sends the configured model and key without provider-specific fields and preserves token usage", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(`\n\n${JSON.stringify(answer())}`));
    const result = await generateJson({ ...request, fetcher });
    expect(result).toMatchObject({ ok: true, data: { ok: true }, tokensIn: 1840, tokensOut: 412 });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe("https://llm.example/v1/chat/completions");
    expect(init?.headers).toMatchObject({ Authorization: "Bearer test-key" });
    expect(JSON.parse(String(init?.body))).toEqual({
      model: "vendor/custom-model", messages: [{ role: "system", content: expect.stringContaining('JSON Schema:\n{"type":"object"}') }, { role: "user", content: "check" }],
      response_format: { type: "json_object" }, temperature: 0, max_tokens: MAX_OUTPUT_TOKENS, stream: false,
    });
  });

  it.each([{ apiKey: "" }, { apiKey: "  " }, { model: "" }, { model: "  " }])("rejects missing credentials or model before HTTP: %j", async (override) => {
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

  it("identifies output limits so extraction can split the batch, retaining usage", async () => {
    expect(await generateJson({ ...request, fetcher: (async () => Response.json(answer('{"items":[', "length"))) as typeof fetch }))
      .toMatchObject({ ok: false, kind: "invalid_output", message: "llm_output_limit", reached: true, tokensIn: 1840, tokensOut: 412 });
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
