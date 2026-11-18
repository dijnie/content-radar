export interface Env {
  DB: D1Database;
  RAW: R2Bucket;
  POLL_QUEUE: Queue;
  LLM_QUEUE: Queue;
  ASSETS: Fetcher;

  /** OpenAI-compatible API base URL or full chat/completions URL. */
  LLM_ENDPOINT?: string;
  /** Server-side secret; never sent to the browser. */
  LLM_API_KEY?: string;
  /** Select one model; unset retains the enabled D1 model chain. Blank pauses LLM work. */
  LLM_MODEL?: string;
  /** Provider model ID for /embeddings on the same endpoint. */
  EMBEDDING_MODEL?: string;
  /** Queue names supplied by deployment setup; defaults support local development. */
  POLL_QUEUE_NAME?: string;
  LLM_QUEUE_NAME?: string;
  DLQ_QUEUE_NAME?: string;
  GITHUB_TOKEN: string;
  /** Optional origin for excluding the app's own hostname during background ingest. */
  APP_ORIGIN?: string;
}
