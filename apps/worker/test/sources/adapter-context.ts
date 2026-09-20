import type { SourceRow } from "../../src/db/sources-repo";
import { fetchJson, fetchText, type HttpOptions } from "../../src/sources/http-client";
import type { AdapterContext } from "../../src/sources/source-adapter";

export type Route = string | { status: number; body?: string; contentType?: string };

/** Adapter context backed by the real HTTP client and a route table instead of the network. */
export function fakeContext(routes: Record<string, Route>, overrides: Partial<AdapterContext> = {}) {
  const requests: { url: string; headers: Record<string, string> }[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, headers: { ...(init?.headers as Record<string, string>) } });
    const route = routes[url];
    if (route === undefined) return new Response("not found", { status: 404 });
    if (typeof route === "string") return new Response(route);
    return new Response(route.body ?? "", { status: route.status, headers: route.contentType ? { "Content-Type": route.contentType } : {} });
  }) as typeof fetch;

  const bound = (options?: HttpOptions): HttpOptions => ({ ...options, fetcher, ownHosts: ["radar.example.com"] });
  const ctx: AdapterContext = {
    now: Date.UTC(2026, 8, 20, 16, 0, 0) / 1000,
    githubToken: null,
    hnMinPoints: 20,
    fetchText: (url, options) => fetchText(url, bound(options)),
    fetchJson: (url, options) => fetchJson(url, bound(options)),
    articleBudget: { remaining: 5 },
    ...overrides,
  };
  return { ctx, requests };
}

export function sourceRow(type: SourceRow["type"], key: string, id = 7): SourceRow {
  return {
    id, type, key, label: key, topic_hint: null, author_key: null, priority: 5, poll_interval_min: 30,
    always_pass: 0, enabled: 1, next_poll_at: 0, cursor_json: null,
  };
}
