import type { Env } from "../env";
import { DEFAULT_DEEPSEEK_MODEL, generateJson } from "../llm/deepseek-client";

// Fixed allow-list: the probe never accepts a caller-supplied URL, so the
// Worker cannot be used as an open proxy.
export const PROBE_TARGETS = [
  "deepseek",
  "fxtwitter-timeline",
  "fxtwitter-status",
  "syndication",
  "hn-algolia",
  "hn-firebase",
  "github-api",
  "github-atom",
  "rss-uber",
  "rss-medium",
  "workers-ai-embed",
] as const;

export type ProbeTarget = (typeof PROBE_TARGETS)[number];

export interface ProbeResult {
  target: ProbeTarget;
  status: number;
  ms: number;
  colo: string | null;
  length: number;
  error?: string;
}

const USER_AGENT = "content-radar-probe/0.1 (personal research crawler)";
const PROBE_TIMEOUT_MS = 15_000;
const PROBE_TWEET_ID = "20";

// Token scheme used by the public embed widget for cdn.syndication.twimg.com.
function syndicationToken(id: string): string {
  return ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, "");
}

function httpRequestFor(target: ProbeTarget, env: Env): Request | null {
  const headers: Record<string, string> = { "User-Agent": USER_AGENT };
  switch (target) {
    case "deepseek":
      return null;
    case "fxtwitter-timeline":
      return new Request("https://api.fxtwitter.com/2/profile/jack/statuses", { headers });
    case "fxtwitter-status":
      return new Request(`https://api.fxtwitter.com/jack/status/${PROBE_TWEET_ID}`, { headers });
    case "syndication":
      return new Request(
        `https://cdn.syndication.twimg.com/tweet-result?id=${PROBE_TWEET_ID}&token=${syndicationToken(PROBE_TWEET_ID)}`,
        { headers },
      );
    case "hn-algolia":
      return new Request("https://hn.algolia.com/api/v1/search_by_date?tags=story&hitsPerPage=5", { headers });
    case "hn-firebase":
      return new Request("https://hacker-news.firebaseio.com/v0/item/1.json", { headers });
    case "github-api":
      return new Request("https://api.github.com/rate_limit", {
        headers: {
          ...headers,
          Accept: "application/vnd.github+json",
          ...(env.GITHUB_TOKEN ? { Authorization: `Bearer ${env.GITHUB_TOKEN}` } : {}),
        },
      });
    case "github-atom":
      return new Request("https://github.com/cloudflare/workers-sdk/releases.atom", { headers });
    case "rss-uber":
      return new Request("https://www.uber.com/blog/engineering/rss/", { headers });
    case "rss-medium":
      return new Request("https://medium.com/feed/airbnb-engineering", { headers });
    case "workers-ai-embed":
      return null;
  }
}

export function isProbeTarget(value: string | null): value is ProbeTarget {
  return value !== null && (PROBE_TARGETS as readonly string[]).includes(value);
}

export async function runProbe(target: ProbeTarget, env: Env, colo: string | null): Promise<ProbeResult> {
  const started = Date.now();
  const base = { target, colo };
  try {
    if (target === "deepseek") {
      const result = await generateJson({
        apiKey: env.DEEPSEEK_API_KEY ?? "", model: DEFAULT_DEEPSEEK_MODEL,
        ...(env.AI_GATEWAY_ID !== undefined ? { gatewayId: env.AI_GATEWAY_ID, ai: env.AI } : {}),
        system: 'Return JSON only. Example: {"ok":true}', user: 'Reply with {"ok":true}.',
        schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
        ...(env.DEEPSEEK_BASE_URL ? { baseUrl: env.DEEPSEEK_BASE_URL } : {}), timeoutMs: PROBE_TIMEOUT_MS,
      });
      return { ...base, status: result.httpStatus ?? 0, ms: result.latencyMs, length: result.ok ? JSON.stringify(result.data).length : 0, ...(!result.ok ? { error: result.message } : {}) };
    }
    const request = httpRequestFor(target, env);
    if (request === null) {
      const output = await env.AI.run("@cf/baai/bge-m3", { text: ["content radar probe"] });
      const length = JSON.stringify(output).length;
      return { ...base, status: 200, ms: Date.now() - started, length };
    }
    const response = await fetch(request, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    const body = await response.text();
    const result: ProbeResult = { ...base, status: response.status, ms: Date.now() - started, length: body.length };
    return result;
  } catch (err) {
    const error = err instanceof Error ? err.name : "unknown_error";
    return { ...base, status: 0, ms: Date.now() - started, length: 0, error };
  }
}

export async function handleProbe(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") return Response.json({ error: "method_not_allowed" }, { status: 405 });
  const target = new URL(request.url).searchParams.get("target");
  if (!isProbeTarget(target)) {
    return Response.json({ error: "unknown_target", targets: PROBE_TARGETS }, { status: 400 });
  }
  const colo = typeof request.cf?.colo === "string" ? request.cf.colo : null;
  return Response.json(await runProbe(target, env, colo));
}
