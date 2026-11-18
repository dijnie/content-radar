import type { Env } from "../env";
import { handleAiSettings } from "./ai-settings-route";
import { handleBackfill } from "./admin-backfill";
import { handleProbe } from "./admin-probe";
import { jsonError } from "./api-errors";
import { handleLlmCalls } from "./llm-calls-route";
import { handleStatus } from "./status-route";
import { handleStoryAction, handleStoryDetail, handleStoryList } from "./stories-routes";
import { handleFeed, handleFeedDetail, handleFeedRead } from "./feeds-routes";
import { handleFeedSchedule, handleJobDetail, handleJobs, handleStartCrawl, handleStartFeed } from "./jobs-routes";

type Handler = (request: Request, env: Env, params: Record<string, string>) => Promise<Response>;

interface Route {
  method: "GET" | "POST";
  pattern: RegExp;
  handler: Handler;
}

/**
 * Public API routes, reached from `fetch` after the same-origin request guard.
 * Route handlers validate input and enforce the existing job and usage limits.
 */
export const ROUTES: readonly Route[] = [
  { method: "GET", pattern: /^\/api\/settings\/ai$/, handler: handleAiSettings },
  { method: "POST", pattern: /^\/api\/settings\/ai$/, handler: handleAiSettings },
  { method: "GET", pattern: /^\/api\/jobs$/, handler: (request, env) => handleJobs(request, env) },
  { method: "GET", pattern: /^\/api\/jobs\/(?<kind>crawl|news|hands-on|deep-dives)\/(?<id>\d{1,15})$/, handler: (_request, env, params) => handleJobDetail(env, params.kind!, Number(params.id)) },
  { method: "POST", pattern: /^\/api\/jobs\/crawls$/, handler: (_request, env) => handleStartCrawl(env) },
  { method: "POST", pattern: /^\/api\/jobs\/feeds\/(?<feed>news|hands-on|deep-dives)$/, handler: (request, env, params) => handleStartFeed(request, env, params.feed!) },
  { method: "POST", pattern: /^\/api\/jobs\/schedules\/(?<feed>news|hands-on|deep-dives)$/, handler: (request, env, params) => handleFeedSchedule(request, env, params.feed!) },
  { method: "GET", pattern: /^\/api\/feeds\/(?<feed>news|hands-on|deep-dives)$/, handler: (request, env, params) => handleFeed(request, env, params.feed!) },
  { method: "GET", pattern: /^\/api\/feeds\/(?<feed>news|hands-on|deep-dives)\/detail$/, handler: (request, env, params) => handleFeedDetail(request, env, params.feed!) },
  { method: "POST", pattern: /^\/api\/feeds\/deep-dives\/read$/, handler: (request, env) => handleFeedRead(request, env) },
  { method: "GET", pattern: /^\/api\/stories$/, handler: (request, env) => handleStoryList(request, env) },
  { method: "GET", pattern: /^\/api\/stories\/(?<id>\d{1,15})$/, handler: (_request, env, params) => handleStoryDetail(env, Number(params.id)) },
  { method: "POST", pattern: /^\/api\/stories\/(?<id>\d{1,15})\/action$/, handler: (request, env, params) => handleStoryAction(request, env, Number(params.id)) },
  { method: "GET", pattern: /^\/api\/status\/llm-calls$/, handler: (request, env) => handleLlmCalls(request, env) },
  { method: "GET", pattern: /^\/api\/status$/, handler: (_request, env) => handleStatus(env) },
  { method: "GET", pattern: /^\/api\/admin\/probe$/, handler: (request, env) => handleProbe(request, env) },
  { method: "POST", pattern: /^\/api\/admin\/backfill$/, handler: (request, env) => handleBackfill(request, env) },
];

export async function routeApi(request: Request, env: Env): Promise<Response> {
  const { pathname } = new URL(request.url);
  const matching = ROUTES.filter((route) => route.pattern.test(pathname));
  if (matching.length === 0) return jsonError(404, "not_found");
  const route = matching.find((candidate) => candidate.method === request.method);
  if (!route) return jsonError(405, "method_not_allowed");
  try {
    return await route.handler(request, env, route.pattern.exec(pathname)?.groups ?? {});
  } catch (err) {
    console.error(JSON.stringify({ event: "api_error", path: pathname, error: err instanceof Error ? err.message : String(err) }));
    return jsonError(500, "internal_error");
  }
}
