import { describe, expect, it } from "vitest";
import { fetchJson, fetchText, HttpError } from "../../src/sources/http-client";

const OWN = ["radar.example.com"];

/** Builds a fetcher from a route table and records every request it receives. */
function fakeFetcher(routes: Record<string, () => Response>) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: { ...(init?.headers as Record<string, string>) } });
    const route = routes[url];
    if (!route) throw new TypeError(`no route for ${url}`);
    return route();
  }) as typeof fetch;
  return { fetcher, calls };
}

const redirect = (location: string) => () => new Response(null, { status: 302, headers: { Location: location } });

async function errorOf(promise: Promise<unknown>): Promise<HttpError> {
  const err = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(err).toBeInstanceOf(HttpError);
  return err as HttpError;
}

describe("fetchText", () => {
  it("follows a safe redirect and identifies itself", async () => {
    const { fetcher, calls } = fakeFetcher({
      "https://a.example/post": redirect("/final"),
      "https://a.example/final": () => new Response("hello"),
    });
    const result = await fetchText("https://a.example/post", { fetcher });
    expect(result).toMatchObject({ status: 200, text: "hello", finalUrl: "https://a.example/final" });
    expect(calls[0]!.headers["User-Agent"]).toContain("content-radar");
  });

  it("refuses a redirect into loopback without requesting it", async () => {
    const { fetcher, calls } = fakeFetcher({ "https://a.example/post": redirect("http://127.0.0.1/admin") });
    const err = await errorOf(fetchText("https://a.example/post", { fetcher, ownHosts: OWN }));
    expect(err).toMatchObject({ kind: "blocked", reason: "internal_address" });
    expect(calls.map((call) => call.url)).toEqual(["https://a.example/post"]);
  });

  it("refuses a redirect to the Worker's own hostname", async () => {
    const { fetcher, calls } = fakeFetcher({ "https://a.example/post": redirect("https://radar.example.com/api/admin/backfill") });
    const err = await errorOf(fetchText("https://a.example/post", { fetcher, ownHosts: OWN }));
    expect(err).toMatchObject({ kind: "blocked", reason: "own_host" });
    expect(calls).toHaveLength(1);
  });

  it("stops after three redirects", async () => {
    const { fetcher, calls } = fakeFetcher({
      "https://a.example/0": redirect("/1"),
      "https://a.example/1": redirect("/2"),
      "https://a.example/2": redirect("/3"),
      "https://a.example/3": redirect("/4"),
      "https://a.example/4": () => new Response("never"),
    });
    const err = await errorOf(fetchText("https://a.example/0", { fetcher }));
    expect(err.reason).toBe("too_many_redirects");
    expect(calls).toHaveLength(4);
  });

  it("does not forward caller headers to another host", async () => {
    const { fetcher, calls } = fakeFetcher({
      "https://api.github.com/x": redirect("https://elsewhere.example/x"),
      "https://elsewhere.example/x": () => new Response("ok"),
    });
    await fetchText("https://api.github.com/x", { fetcher, headers: { Authorization: "Bearer secret" } });
    expect(calls[0]!.headers.Authorization).toBe("Bearer secret");
    expect(calls[1]!.headers.Authorization).toBeUndefined();
  });

  it.each([
    [429, "rate_limited"],
    [404, "not_found"],
    [410, "not_found"],
    [403, "blocked"],
    [406, "blocked"],
    [503, "transient"],
  ])("classifies HTTP %i as %s", async (status, kind) => {
    const { fetcher } = fakeFetcher({ "https://a.example/": () => new Response("x", { status }) });
    expect(await errorOf(fetchText("https://a.example/", { fetcher }))).toMatchObject({ kind, status });
  });

  it("classifies a network failure as transient", async () => {
    const { fetcher } = fakeFetcher({});
    expect(await errorOf(fetchText("https://a.example/", { fetcher }))).toMatchObject({ kind: "transient" });
  });

  it("survives a decompression bomb by cancelling at the byte cap", async () => {
    // 200 MB of zeros gzip down to roughly 200 KB; the client must never inflate it all.
    const TOTAL = 200 * 1024 * 1024;
    const CHUNK = new Uint8Array(64 * 1024);
    let produced = 0;
    const zeros = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (produced >= TOTAL) return controller.close();
        produced += CHUNK.byteLength;
        controller.enqueue(CHUNK);
      },
    });
    const bomb = new Uint8Array(await new Response(zeros.pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
    expect(bomb.byteLength).toBeLessThan(900 * 1024);

    let inflated = 0;
    const counter = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        inflated += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });
    const body = new Response(bomb).body!.pipeThrough(new DecompressionStream("gzip")).pipeThrough(counter);
    const { fetcher } = fakeFetcher({ "https://a.example/bomb": () => new Response(body) });

    const err = await errorOf(fetchText("https://a.example/bomb", { fetcher, maxBytes: 1_000_000 }));
    expect(err).toMatchObject({ kind: "blocked", reason: "body_too_large" });
    expect(inflated).toBeLessThan(4 * 1024 * 1024);
  }, 60_000);
});

describe("fetchJson", () => {
  it("parses JSON and reports invalid JSON as transient", async () => {
    const { fetcher } = fakeFetcher({
      "https://a.example/ok": () => Response.json({ n: 1 }),
      "https://a.example/bad": () => new Response("<html>"),
    });
    expect(await fetchJson("https://a.example/ok", { fetcher })).toEqual({ n: 1 });
    expect(await errorOf(fetchJson("https://a.example/bad", { fetcher }))).toMatchObject({ kind: "transient", reason: "invalid_json" });
  });
});
