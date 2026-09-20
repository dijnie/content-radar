import { X_HANDLE_PATTERN } from "@radar/core";
import type { SourceRow } from "../db/sources-repo";
import { buildAdapterContext, ingestPollResult, type IngestEnv } from "../ingest/poll-consumer";
import { HttpError } from "../sources/http-client";
import { fetchTimeline } from "../sources/x-fxtwitter";

const MAX_DAYS = 15;
const MAX_PAGES = 30;
/** FxTwitter is a community service with no published quota; pages are spaced out. */
const PAGE_DELAY_MS = 2000;

export interface BackfillDeps {
  now?: number;
  fetcher?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export interface BackfillSummary {
  handle: string;
  days: number;
  pages: number;
  itemsNew: number;
  enqueued: number;
  stoppedBecause: "reached_cutoff" | "no_more_pages" | "page_limit" | "upstream_error";
}

/** Walks a tracked X account's timeline backwards. Items are marked `backfill` so they draw on their own LLM budget share. */
export async function backfillX(env: IngestEnv, source: SourceRow, days: number, deps: BackfillDeps = {}): Promise<BackfillSummary> {
  const now = deps.now ?? Math.floor(Date.now() / 1000);
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const cutoff = now - days * 86_400;
  const { ctx, filter } = await buildAdapterContext(env, now, deps.fetcher);
  const summary: BackfillSummary = { handle: source.key, days, pages: 0, itemsNew: 0, enqueued: 0, stoppedBecause: "page_limit" };

  let cursor: string | undefined;
  while (summary.pages < MAX_PAGES) {
    if (summary.pages > 0) await sleep(PAGE_DELAY_MS);
    let page;
    try {
      page = await fetchTimeline(source.key, ctx, cursor);
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      summary.stoppedBecause = "upstream_error";
      break;
    }
    summary.pages++;
    const inWindow = { ...page, items: page.items.filter((item) => item.publishedAt >= cutoff) };
    const stored = await ingestPollResult(env, source, inWindow, filter, now, "backfill");
    summary.itemsNew += stored.itemsNew;
    summary.enqueued += stored.enqueued;

    if (page.items.length === 0 || page.items.some((item) => item.publishedAt < cutoff)) {
      summary.stoppedBecause = page.items.length === 0 ? "no_more_pages" : "reached_cutoff";
      break;
    }
    const bottom = (page.cursor as { bottom?: string | null } | undefined)?.bottom;
    if (!bottom || bottom === cursor) {
      summary.stoppedBecause = "no_more_pages";
      break;
    }
    cursor = bottom;
  }
  return summary;
}

/** `POST /api/admin/backfill { handle, days }`. Reached only behind the Access check and the CSRF guard. */
export async function handleBackfill(request: Request, env: IngestEnv, deps: BackfillDeps = {}): Promise<Response> {
  if (request.method !== "POST") return Response.json({ error: "method_not_allowed" }, { status: 405 });
  let body: { handle?: unknown; days?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  const { handle, days } = body;
  if (typeof handle !== "string" || !X_HANDLE_PATTERN.test(handle)) return Response.json({ error: "invalid_handle" }, { status: 400 });
  if (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > MAX_DAYS) {
    return Response.json({ error: "invalid_days", max: MAX_DAYS }, { status: 400 });
  }
  const source = await env.DB.prepare("SELECT * FROM sources WHERE type = 'x' AND LOWER(key) = LOWER(?)").bind(handle).first<SourceRow>();
  if (!source) return Response.json({ error: "unknown_source" }, { status: 404 });
  return Response.json(await backfillX(env, source, days, deps));
}
