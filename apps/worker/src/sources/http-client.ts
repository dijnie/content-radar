import { checkOutboundUrl } from "./url-guard";

export const USER_AGENT = "content-radar/0.1 (personal research crawler)";

export type HttpErrorKind = "blocked" | "rate_limited" | "not_found" | "transient";

export class HttpError extends Error {
  constructor(
    readonly kind: HttpErrorKind,
    readonly reason: string,
    readonly status: number | null = null,
  ) {
    super(`${kind}: ${reason}`);
    this.name = "HttpError";
  }
}

export interface HttpOptions {
  headers?: Record<string, string>;
  /** Cap on the body size after decompression. */
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  /** Hostnames of this Worker, which a crawled URL must never reach. */
  ownHosts?: readonly string[];
  fetcher?: typeof fetch;
}

export interface HttpTextResponse {
  status: number;
  text: string;
  finalUrl: string;
  headers: Headers;
}

const DEFAULTS = { maxBytes: 1_000_000, timeoutMs: 10_000, maxRedirects: 3 };

function kindForStatus(status: number): HttpErrorKind {
  if (status === 429) return "rate_limited";
  if (status === 404 || status === 410) return "not_found";
  if (status >= 500) return "transient";
  return "blocked";
}

/** Reads the body while counting bytes, and cancels the stream once the cap is passed. */
async function readCapped(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel("body_too_large");
      throw new HttpError("blocked", "body_too_large");
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

/**
 * GET with manual redirects. Every hop is re-checked by the URL guard, and
 * caller headers (which may carry a token) are only sent to the first host.
 */
export async function fetchText(rawUrl: string | URL, options: HttpOptions = {}): Promise<HttpTextResponse> {
  const { maxBytes, timeoutMs, maxRedirects } = { ...DEFAULTS, ...options };
  const fetcher = options.fetcher ?? fetch;
  const signal = AbortSignal.timeout(timeoutMs);
  let current: string | URL = rawUrl;
  let firstHost: string | null = null;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const verdict = checkOutboundUrl(current, options.ownHosts);
    if (!verdict.ok) throw new HttpError("blocked", verdict.reason);
    firstHost ??= verdict.url.host;
    const headers = { "User-Agent": USER_AGENT, ...(verdict.url.host === firstHost ? options.headers : undefined) };

    let response: Response;
    try {
      response = await fetcher(verdict.url.toString(), { headers, redirect: "manual", signal });
    } catch (err) {
      throw new HttpError("transient", err instanceof Error ? err.name : "network_error");
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("Location");
      await response.body?.cancel();
      if (!location) throw new HttpError("transient", "redirect_without_location", response.status);
      current = new URL(location, verdict.url);
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new HttpError(kindForStatus(response.status), `http_${response.status}`, response.status);
    }
    try {
      const text = await readCapped(response, maxBytes);
      return { status: response.status, text, finalUrl: verdict.url.toString(), headers: response.headers };
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError("transient", err instanceof Error ? err.name : "read_error");
    }
  }
  throw new HttpError("blocked", "too_many_redirects");
}

export async function fetchJson<T>(rawUrl: string | URL, options: HttpOptions = {}): Promise<T> {
  const { text } = await fetchText(rawUrl, { maxBytes: 5_000_000, ...options });
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HttpError("transient", "invalid_json");
  }
}
