export interface Env {
  DB: D1Database;
  RAW: R2Bucket;
  POLL_QUEUE: Queue;
  LLM_QUEUE: Queue;
  AI: Ai;
  ASSETS: Fetcher;

  /** OpenAI-compatible API base URL or full chat/completions URL. */
  LLM_ENDPOINT?: string;
  /** Server-side secret; never sent to the browser. */
  LLM_API_KEY?: string;
  /** Select one model; unset retains the enabled D1 model chain. Blank pauses LLM work. */
  LLM_MODEL?: string;
  GITHUB_TOKEN: string;
  OWNER_EMAIL: string;
  /** Team origin, e.g. https://<team>.cloudflareaccess.com (no trailing slash). */
  ACCESS_TEAM_DOMAIN: string;
  /** Application Audience (AUD) tag of the Access application. */
  ACCESS_AUD: string;
  /** Exact deployed origin, e.g. https://radar.example.com. */
  APP_ORIGIN: string;
}

declare global {
  /** Build-time constant. Only wrangler.dev.jsonc sets it to true. */
  const __DEV_AUTH_BYPASS__: boolean;
}
