export interface Env {
  DB: D1Database;
  RAW: R2Bucket;
  POLL_QUEUE: Queue;
  LLM_QUEUE: Queue;
  AI: Ai;
  ASSETS: Fetcher;

  /** Only required for direct calls; AI Gateway uses its stored provider key. */
  DEEPSEEK_API_KEY?: string;
  /** Select the AI binding and its stored default DeepSeek key. */
  AI_GATEWAY_ID?: string;
  GITHUB_TOKEN: string;
  OWNER_EMAIL: string;
  /** Team origin, e.g. https://<team>.cloudflareaccess.com (no trailing slash). */
  ACCESS_TEAM_DOMAIN: string;
  /** Application Audience (AUD) tag of the Access application. */
  ACCESS_AUD: string;
  /** Exact deployed origin, e.g. https://radar.example.com. */
  APP_ORIGIN: string;
  /** Direct local API only; unset means https://api.deepseek.com. */
  DEEPSEEK_BASE_URL?: string;
}

declare global {
  /** Build-time constant. Only wrangler.dev.jsonc sets it to true. */
  const __DEV_AUTH_BYPASS__: boolean;
}
