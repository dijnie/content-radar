export interface Env {
  DB: D1Database;
  RAW: R2Bucket;
  POLL_QUEUE: Queue;
  LLM_QUEUE: Queue;
  DLQ_QUEUE: Queue;
  ASSETS: Fetcher;

  /** Queue names supplied by deployment setup; defaults support local development. */
  POLL_QUEUE_NAME?: string;
  LLM_QUEUE_NAME?: string;
  DLQ_QUEUE_NAME?: string;
  GITHUB_TOKEN: string;
  /** Runtime secret for unlocking the AI provider settings. */
  OWNER_TOKEN?: string;
  /** Optional origin for excluding the app's own hostname during background ingest. */
  APP_ORIGIN?: string;
}
