# Cloudflare + Gemini Free-Tier Platform Facts for Content Radar

Date: 2026-09-20. Scope: read-only platform research to support planning. No code written.

## 1. Workers Paid: limits and what $5 includes

| Dimension | Limit | Source |
|---|---|---|
| CPU time, HTTP request | Default 30s, configurable up to 5 min (300,000 ms) | [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) |
| CPU time, Cron Trigger | 30s if interval < 1 hour, else up to 15 min | [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) |
| CPU time, Queue consumer | Up to 15 min | [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) |
| CPU time, Workflows step | Default 30s, configurable up to 5 min active CPU per step | [Workflows limits](https://developers.cloudflare.com/workflows/reference/limits/) |
| Memory | 128 MB per isolate | [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) |
| Subrequests | 10,000/invocation default, configurable up to 10M | [Workers limits](https://developers.cloudflare.com/workers/platform/limits/); [changelog 2026-02-11](https://developers.cloudflare.com/changelog/post/2026-02-11-subrequests-limit/) |
| Cron Triggers | Up to 5 per Worker (free plan allows 3); 250 cron triggers per account | [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) |
| Worker script size | 64 MiB uncompressed | [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) |
| Simultaneous open connections | 6 per invocation | [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) |

Pricing (Workers Paid, [pricing page](https://developers.cloudflare.com/workers/platform/pricing/)): $5/month minimum includes 10M requests and 30M CPU-ms. Overage is $0.30 per additional million requests and $0.02 per additional million CPU-ms. Wall-clock time (I/O wait, e.g. waiting on Gemini's HTTP response) is not billed CPU time, so a cron Worker calling Gemini and D1 mostly pays for actual compute, not network latency. This project's workload (periodic crawl + cheap filter + JSON parsing) is very unlikely to exceed the included 30M CPU-ms/month at personal scale.

## 2. Queues vs Workflows — recommendation: Queues

| Dimension | Queues (Paid) | Workflows (Paid) |
|---|---|---|
| Retention / durability of backlog | Configurable up to 14 days ([Queues limits](https://developers.cloudflare.com/queues/platform/limits/)) | State retention 30 days; sleep up to 365 days ([Workflows limits](https://developers.cloudflare.com/workflows/reference/limits/)) |
| Max delay (retry/backoff) | 24 hours per `retry()`/`send()` call ([batching-retries](https://developers.cloudflare.com/queues/configuration/batching-retries/)) | Sleep up to 365 days, no per-call cap |
| Batch size | Default 10, max 100 messages/batch; `sendBatch` max 100 or 256 KB | N/A (per-instance, not batch-native) |
| Message/step size | 128 KB per message | 1 MiB per step result / event payload |
| DLQ | Native: failed messages after max retries (default 3, up to 100) route to a configured dead-letter queue | No native DLQ; failure handling is manual (catch + persist to D1/R2) |
| Retries | Up to 100 retries/message, explicit `retry()`/`retryAll()` with per-call delay | Up to 10,000 retries/step, built-in exponential backoff |
| Throughput/backlog cap | 5,000 msg/s per queue, 25 GB backlog per queue | 50,000 concurrent instances, 2,000,000 queued instances |
| Pricing | 1M operations/month included, then $0.40/million (write+read+delete≈3 ops/message) ([Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/)) | 500,000 steps/month included, then $0.80/100,000 steps; storage $0.20/GB-month beyond 1 GB included ([Workflows pricing](https://developers.cloudflare.com/workflows/reference/pricing/)) |
| Per-step billing start | N/A | "No earlier than 2026-08-10" per [changelog](https://developers.cloudflare.com/changelog/post/2026-07-07-workflows-billing-updates/); today is 2026-09-20, so this is very likely already active — confirm current bill in dashboard before assuming free step allowance. |

**Recommendation: Cloudflare Queues** for the fan-out/extract stage (per-source and per-account crawl jobs feeding a consumer that calls Gemini). Rationale, KISS-aligned:

- The workload is naturally a queue of independent per-item jobs (one message per candidate post/claim-extraction call), not a long sequential multi-step saga — Queues' pull/push consumer model matches this directly; Workflows' durable-execution model (steps, `step.do`, `step.sleep`) adds ceremony this pipeline does not need.
- 14-day message retention on Paid comfortably covers "backlog survives a day or more" of Gemini quota exhaustion; combined with `retry()` using a growing `delaySeconds` (up to 24h per call, called repeatedly across the retry budget of up to 100 attempts) a message can realistically be re-queued for many days without loss.
- Native DLQ gives a clean "permanently failed" bucket for `source_health` bookkeeping, which Workflows lacks natively.
- Cost is lower at this small scale (1M operations included vs Workflows' 500,000 steps included, and Queues counts 3 ops/message vs one Workflows step per unit of work).
- Rate limiting to a daily Gemini quota is not native to either service — plan to implement it as application logic in the consumer: check the D1 budget ledger before calling Gemini, and if exhausted, call `message.retry({ delaySeconds })` (or `retryAll`) to push the message back with a delay, relying on consumer concurrency settings to throttle call rate. This must be built regardless of Queues vs Workflows choice, so it does not affect the decision.
- Workflows remains a good fit later only if the pipeline gains genuinely sequential, long-running, human-in-the-loop-like steps (e.g., "wait for next day's quota reset, then continue this same logical unit of work" across weeks) — not needed for the current per-item extraction fan-out.

## 3. D1 (Paid plan)

| Item | Value | Source |
|---|---|---|
| Max database size | 10 GB | [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) |
| Max storage per account | 1 TB | [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) |
| Max row/BLOB/string size | 2,000,000 bytes (2 MB) | [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) |
| Max SQL statement length | 100,000 bytes (100 KB) | [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) |
| Max bound parameters per query | 100 | [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) |
| Rows read included / price | 25 billion/month included, then $0.001/million | [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) |
| Rows written included / price | 50 million/month included, then $1.00/million | [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) |
| Storage included / price | 5 GB included, then $0.75/GB-month | [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) |
| Time Travel retention | 30 days (Paid) vs 7 days (Free); always-on, no opt-in | [Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/) |
| Time Travel restore rate | Up to 10 restores per 10 minutes per database (per web summary of docs; verify in dashboard before relying on it operationally) | secondary summary of [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) |

FTS5: supported and compiled into D1 by default, including `fts5vocab`; ranking via BM25 and `snippet()`/`highlight()` work as in stock SQLite. Gotcha: **virtual tables (including FTS5 tables) are not included in `wrangler d1 export`** — the documented workaround is to drop virtual tables, export, then recreate them. ([Import/export docs](https://developers.cloudflare.com/d1/best-practices/import-export-data/))

JSON functions: D1 supports SQLite's JSON extension, including `json_extract()`, the `->`/`->>` operators, and JSON path syntax (`$.key`, `$.key[2]`), useful for querying the claims/entities JSON blobs from Gemini before fully normalizing them. ([Query JSON](https://developers.cloudflare.com/d1/sql-api/query-json/))

Migrations: `wrangler d1 migrations create`, `apply` (local/remote) is the standard workflow; the official best-practices doc for import/export references the migrations flow but the fetched page did not spell out every subcommand — verify exact flag names against `wrangler d1 migrations --help` at implementation time.

Time Travel: always-on point-in-time recovery, restore any minute in the last 30 days on Paid via `wrangler d1 time-travel restore <db> --timestamp=<unix-or-rfc3339>`; restore is destructive (overwrites in place) and prompts for confirmation. ([Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/))

Export: `wrangler d1 export <db> --remote --output=file.sql` for full or selective (schema-only/data-only/single-table) dumps. ([Import/export docs](https://developers.cloudflare.com/d1/best-practices/import-export-data/))

Read replication: The D1 Sessions API enables read replicas across six regions (ENAM, WNAM, WEUR, EEUR, APAC, OC) at no extra cost (billed the same as primary by rows read/written), but the Sessions API is only exposed via the Workers binding, not the REST API — irrelevant to a single-user, single-region personal tool, and adds read-after-write consistency complexity that should be avoided (do not enable it; keep all reads/writes on the primary via the default binding). ([Read replication](https://developers.cloudflare.com/d1/best-practices/read-replication/))

`wrangler d1 execute --remote --json`: runs the given SQL against the live remote database and returns machine-readable JSON (array of result sets, each with `results`, `success`, and `meta` including `rows_read`/`rows_written`/`duration`), which is exactly what the plan's Claude/Codex analyst layer needs for scripted verification queries.

Bulk-insert gotchas: a single INSERT is capped by both the 100-bound-parameter limit and the 100 KB statement-length limit — with e.g. 10 columns this means roughly 10 rows per multi-row `INSERT ... VALUES (...),(...)`, so bulk loads (e.g., initial claim/entity backfill) must be chunked into many statements, ideally sent as one D1 **batch** (`db.batch([...])`) rather than one giant statement, since D1 batches execute sequentially in a single implicit transaction while each individual statement in the batch still respects the same per-statement limits.

## 4. Static hosting and auth

**Pages vs Workers static assets**: As of 2026, Cloudflare's own guidance is to start new projects on **Workers with static assets**, not Pages. Workers now has feature parity with Pages for static assets, SSR, and custom domains, and Cloudflare states future investment is concentrated on Workers; Pages is not deprecated but is in maintenance mode for existing projects. A single Worker can serve both the static frontend build output (configured under `assets` in `wrangler.jsonc`) and the API/cron/queue-consumer logic from one deployment — this matches KISS for a one-repo personal project (one Worker, one deploy, one `wrangler.jsonc`). ([Migrate from Pages to Workers](https://developers.cloudflare.com/workers/static-assets/migration-guides/migrate-from-pages/); corroborated by multiple 2026 comparison posts, treated as secondary confirmation only, e.g. [mecanik.dev](https://mecanik.dev/en/posts/cloudflare-pages-vs-workers-which-to-use-in-2026/))

**Auth via Cloudflare Access (Zero Trust Free plan)**: Free plan covers up to 50 seats (authenticated users) with full ZTNA/SWG/CASB capability, 24-hour log retention, and community support — one person needs exactly 1 seat, so this is $0 for the single-user requirement. ([Zero Trust plans](https://www.cloudflare.com/plans/zero-trust-services/); seat mechanics confirmed at [Seat management](https://developers.cloudflare.com/cloudflare-one/team-and-resources/users/seat-management/)) Setup cost is configuration only: add the Worker's route/hostname as a "self-hosted application" in Zero Trust, attach an Access policy (e.g., "email equals <owner email>" with a one-time-PIN or Google identity provider), no code changes required in the Worker itself since Access enforces at Cloudflare's edge before the request reaches the Worker.

## 5. R2 vs D1 for raw crawled text

R2 free tier (Standard storage only): 10 GB-month storage, 1M Class A ops/month, 10M Class B ops/month, and egress is free on all tiers. Beyond that: $0.015/GB-month storage, $4.50/million Class A ops, $0.36/million Class B ops. ([R2 pricing](https://developers.cloudflare.com/r2/pricing/))

**Recommendation**: store raw crawled payloads (full tweet/post JSON, HTML, RSS entries) in R2, and store only normalized, bounded fields (claim text, short excerpts, URLs, scores, metadata) in D1. This is forced by D1's 2 MB per-row/BLOB/string ceiling — a raw scraped page or large JSON blob can exceed that, and even when it does not, keeping bulky raw text in D1 wastes the 5 GB included storage and the rows-written budget. R2's 10 GB free storage and 1M free Class A (write) ops/month comfortably cover a personal crawl volume of a few hundred to low-thousands of items/day.

## 6. Gemini API free tier (verified against official docs, 2026-09-20)

**Model lineup — the user's "Gemini 3.8 -> 3.6" naming is real**, not confused with older versions. Confirmed current lineup as of 2026-09-20:

| Model family | Released | API model ID | Free tier | Source |
|---|---|---|---|---|
| Gemini 3 Pro / 3 DeepThink | 2025-11-18 | (pro tier, not confirmed free) | Not confirmed free | [Gemini 3 (AI) — Wikipedia](https://en.wikipedia.org/wiki/Gemini_3_(AI)) |
| Gemini 3.1 Pro | 2026-02-19 | `gemini-3.1-pro-preview` | Preview/paid-leaning | [ai.google.dev/gemini-api/docs/models](https://ai.google.dev/gemini-api/docs/models) |
| Gemini 3.6 Flash | 2026-07-21 | `gemini-3.6-flash` | Free tier available | [blog.google 3.6 announcement context](https://ai.google.dev/gemini-api/docs/models); [DeepMind model card](https://deepmind.google/models/model-cards/gemini-3-6-flash/) |
| Gemini 3.7 Flash | mid-2026 | `gemini-3.7-flash` | Free tier available | [DeepMind model card](https://deepmind.google/models/model-cards/gemini-3-7-flash/) |
| Gemini 3.8 Flash / 3.8 Flash Cyber / 3.8 Live | 2026-09-02 | `gemini-3.8-flash` | Free tier available | [Google blog: 3.8 Flash and 3.8 Flash Cyber](https://blog.google/innovation-and-ai/models-and-research/gemini-models/3-8-flash-and-3-8-flash-cyber/); [ai.google.dev latest-model](https://ai.google.dev/gemini-api/docs/latest-model) |
| Gemini Embedding / Embedding 2 | — | `gemini-embedding-001`, `gemini-embedding-2-preview` | Embedding 2 has a free tier | [ai.google.dev/gemini-api/docs/models](https://ai.google.dev/gemini-api/docs/models) |

Context window: `gemini-3.8-flash` supports a 1M-token input context window and up to 64K max output tokens, with tunable "thinking" levels (low/medium/high). ([ai.google.dev latest-model](https://ai.google.dev/gemini-api/docs/latest-model))

**Rate limits (RPM/TPM/RPD)**: The official rate-limits page ([ai.google.dev/gemini-api/docs/rate-limits](https://ai.google.dev/gemini-api/docs/rate-limits)) explicitly states limits "depend on a variety of factors (such as your usage tier) and can be viewed in Google AI Studio" at `https://aistudio.google.com/rate-limit` — this page requires the user's own Google login and could not be fetched anonymously. Numerous third-party blog posts quote specific numbers (e.g., "2.5 Flash: 10 RPM/250 RPD", "Flash-Lite: 15 RPM/1000 RPD") but these are unverified low-authority sources, reference older 2.5-series models, and conflict with each other — **do not hardcode any specific RPM/RPD number into the design; treat free-tier quota as configuration read from the user's own AI Studio dashboard**, exactly as the project's brainstorm contract already assumes (see unresolved question 1 in the contract). This is the single most important "verify yourself" item in this report.

**429 errors**: returned as HTTP 429 with gRPC-style status `RESOURCE_EXHAUSTED`. Official guidance is to back off and retry, and to reduce request cost (smaller context, shorter output); the fetched official page did not document a specific `Retry-After` header format, so the pipeline should implement its own exponential backoff rather than assume a machine-readable retry hint is present. ([Rate limits docs](https://ai.google.dev/gemini-api/docs/rate-limits))

**Structured output**: Native Gemini API `generationConfig` supports `responseMimeType: "application/json"` plus either `responseSchema` (a constrained OpenAPI-schema subset) or `responseJsonSchema` (fuller JSON Schema support, mutually exclusive with `responseSchema`) — recommended field for this project's claim/entity extraction is `responseJsonSchema` since it supports richer JSON Schema features (unions, `$ref`) than the OpenAPI-subset `responseSchema`. Both are documented in the REST reference at `ai.google.dev/api/generate-content`, corroborated by [Firebase AI Logic docs](https://firebase.google.com/docs/ai-logic/generate-structured-output) and the Google AI developer forum. Only a subset of JSON Schema is supported; very large/deeply nested schemas may be rejected — keep the claims/entities schema flat and small.

**Data-use terms on free tier**: For unpaid ("free") API usage, Google's terms state content submitted and generated responses may be used "to provide, improve, and develop Google products and services," and human reviewers may read/annotate inputs and outputs — avoid sending sensitive personal data through the free tier. Paid tier usage is excluded from training use under the Data Processing Addendum. ([Gemini API additional terms](https://ai.google.dev/gemini-api/terms)) This is relevant only as a privacy note since crawled content here is already public.

**Embedding on free tier**: `gemini-embedding-2-preview` reportedly has a free allowance per the models page, but exact RPM/RPD for embeddings were not shown on the fetched pricing page — treat as unconfirmed and prefer Workers AI's free embedding allocation (Section 8) for entity-alias resolution instead, since that allocation is precisely quantified.

## 7. "User location is not supported" from Cloudflare Workers egress

This is a real, still-occurring issue in 2026, not something Google fixed. Root cause: Google gates the Gemini API by the request's apparent origin location, and Cloudflare Workers execute at whichever edge PoP is closest to the inbound trigger (for a cron-triggered Worker, this can be an unpredictable global PoP, including regions Google does not serve, e.g. reports specifically call out Hong Kong). Confirmed via a live Cloudflare Community thread from 2026 explicitly requesting Cloudflare "do not put Workers in LLM-forbidden locations." ([Cloudflare Community thread](https://community.cloudflare.com/t/do-not-put-workers-in-llm-forbidden-locations/711754/1); background from [Google Gemini CLI discussion #1663](https://github.com/google-gemini/gemini-cli/discussions/1663) and older [generative-ai-js issue #151](https://github.com/google-gemini/generative-ai-js/issues/151))

**Documented workarounds**:
- **Placement Hints** (GA feature, distinct from Smart Placement): a Worker can be configured with `"placement": {"mode": "region", "region": "us"}` or similar cloud-region hints (AWS/GCP/Azure region identifiers) to bias execution toward supported regions; this is the most direct fix. ([Placement docs](https://developers.cloudflare.com/workers/configuration/placement/); [changelog 2026-01-22 placement hints](https://developers.cloudflare.com/changelog/post/2026-01-22-explicit-placement-hints/))
- **Smart Placement** (`"mode": "smart"`) optimizes for latency to a Worker's most-called backend, not for regulatory/geo-gating — it may incidentally help but is not the documented fix for this specific error; Placement Hints with an explicit region is the more reliable tool.
- **Cloudflare AI Gateway with Google AI Studio/Gemini as provider**: AI Gateway proxies the request through Cloudflare's own gateway infrastructure; because AI Gateway is a Cloudflare-operated service reached over Cloudflare's network before egressing to Google, it can normalize the effective egress point and has been reported anecdotally to sidestep the location error, though no Cloudflare or Google document guarantees this as an official fix — treat it as a secondary mitigation, with Placement Hints as primary.
- Since the specific edge PoP a cron trigger lands on is not fully deterministic without Enterprise-only Regions/jurisdictions, plan for this as an operational risk: log every Gemini call's HTTP status/error, and have the fallback chain retry through a differently-configured Worker route (e.g., a Placement-Hinted route) or AI Gateway if a location error is detected, per `source_health`-style bookkeeping already planned in D1.

**AI Gateway cost**: Free — core features (analytics dashboard, caching, rate limiting) are offered at no charge and require only a Cloudflare account and pointing requests at the gateway URL. Log storage has a plan-based cap (100,000 logs total on Free, 10,000,000 logs/gateway on Paid); Logpush (exporting logs elsewhere) is Paid-only; the Guardrails feature bills through Workers AI token pricing if enabled. For this project, AI Gateway is useful specifically for its free response caching (avoids redundant Gemini calls) and free rate limiting (an extra guard rail on top of the D1 budget ledger), at no additional cost. ([AI Gateway overview](https://developers.cloudflare.com/ai-gateway/); [AI Gateway pricing](https://developers.cloudflare.com/ai-gateway/pricing/))

## 8. Workers AI free allocation and Vectorize, as an alternative to Gemini embeddings

| Item | Value | Source |
|---|---|---|
| Workers AI free daily allocation | 10,000 Neurons/day, on both Free and Paid plans | [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/) |
| Overage rate | $0.011 per 1,000 Neurons (Paid only; Free plan has no overage) | [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/) |
| `@cf/baai/bge-m3` embedding cost | ~1,075 Neurons per million input tokens | [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/) |
| Vectorize free tier | 5M stored vector-dimensions/month, 30M queried vector-dimensions/month, no overage available on Free | [Vectorize pricing](https://developers.cloudflare.com/vectorize/platform/pricing/) |
| Vectorize paid tier | 10M stored dims included then $0.05/100M; 50M queried dims included then $0.01/million | [Vectorize pricing](https://developers.cloudflare.com/vectorize/platform/pricing/) |

**Cost at ~5,000 embeddings/day**: assuming short entity-alias strings (well under 100 tokens each), 5,000 embeddings/day is a small fraction of typical per-embedding token counts needed to exhaust 10,000 Neurons/day via `bge-m3` (roughly 1,075 Neurons per million tokens means 5,000 short strings, even at ~50 tokens each = 250,000 tokens/day, cost ≈ 269 Neurons — well inside the free 10,000/day allocation). This makes Workers AI embeddings effectively free for this project's alias-resolution volume, and is a more precisely quantified free allowance than Gemini's embedding free tier (which this research could not pin down numerically). **Recommend `@cf/baai/bge-m3` on Workers AI for entity-alias resolution**, not Gemini embeddings, both to conserve the scarcer Gemini quota for claim extraction and because the Workers AI allocation is exactly bounded and documented.

## 9. Repo/Wrangler layout best practice (2026)

- **Config format**: `wrangler.jsonc` is Cloudflare's current default for new projects (scaffolded by `npm create cloudflare` since 2025), and Cloudflare states some newer Wrangler features are JSON-config-only; `wrangler.toml` remains fully supported with identical schema, only syntax differs. Use `wrangler.jsonc` for this greenfield project. ([Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/))
- **One Worker, multiple triggers**: a single `wrangler.jsonc` can declare `triggers.crons`, a `queues.consumers` binding, and an `assets` block for the static frontend simultaneously, all handled by one `export default { fetch, scheduled, queue }` Worker entry — this matches the plan's single-Worker design (cron + queue consumer + API + static assets in one deployment).
- **Monorepo shape**: put the pure graph/Leiden/scoring core in a plain TypeScript package with no Workers-runtime imports (testable under plain Node + Vitest, no Miniflare needed), and the Worker package imports it as a local workspace dependency (npm/pnpm workspaces). Only the Worker package needs `@cloudflare/vitest-pool-workers`.
- **`@cloudflare/vitest-pool-workers`**: actively maintained, GA-quality tool that runs tests inside the actual `workerd` runtime (not a Node approximation), giving faithful behavior for bindings (D1, Queues, R2) and Web APIs; configured via `wrangler: { configPath: "./wrangler.jsonc" }` in `vitest.config.ts`. ([Cloudflare blog: Workers Vitest integration](https://blog.cloudflare.com/workers-vitest-integration/); [Vitest integration configuration docs](https://developers.cloudflare.com/workers/testing/vitest-integration/configuration/))
- **Local dev of cron**: `wrangler dev --test-scheduled` exposes an HTTP route `/cdn-cgi/local/scheduled` (optionally with a `cron=` query param) to manually invoke the `scheduled()` handler without waiting for a real trigger; cron triggers otherwise only fire automatically once deployed, never in local dev. ([Multiple cron triggers example](https://developers.cloudflare.com/workers/examples/multiple-cron-triggers/); community/GitHub issue corroboration only — exact current flag behavior should be spot-checked against `wrangler dev --help` at implementation time since related GitHub issues note friction combining `--test-scheduled` with the `assets` config)
- **Local dev of Queues/D1**: `wrangler dev` runs Queues and D1 locally via Miniflare (the same simulation engine underlying `vitest-pool-workers`), giving locally-consistent behavior for consumer batching and D1 SQL without touching remote resources; use `--remote` flags selectively when a step (e.g., first-time schema migration) must hit the real D1 instance.
- **D1 migrations**: manage schema changes with `wrangler d1 migrations create <db> <name>` and apply with `wrangler d1 migrations apply <db>` (add `--local` for Miniflare, `--remote` for the live database) — this is the standard, documented Cloudflare-native migration flow; exact subcommand flags should be confirmed against `wrangler d1 migrations --help` since the fetched best-practices page referenced but did not fully enumerate this command.

## Unverified / could not confirm

- **Exact Gemini free-tier RPM/TPM/RPD numbers** for `gemini-3.8-flash`, `gemini-3.6-flash`, and other current models. Google's own docs defer entirely to the per-account AI Studio dashboard (`aistudio.google.com/rate-limit`), which requires login and could not be fetched by this research. Multiple third-party blog posts give conflicting numbers for older 2.5-series models; none should be trusted as current. **Action for the user**: read the live numbers from your own AI Studio dashboard before finalizing the daily-budget-ledger design.
- **Whether Cloudflare AI Gateway reliably fixes the Gemini "User location is not supported" error.** No Cloudflare or Google document makes this claim explicitly; it is an anecdotal community mitigation. Placement Hints with an explicit region is the better-documented fix.
- **D1 "queries per invocation" and "Time Travel restores per 10 minutes" exact figures** came from a secondary summary of the official limits page rather than a directly quoted line from `developers.cloudflare.com/d1/platform/limits`; the page's raw table structure did not survive the fetch/summarize step cleanly. Recommend a quick manual check of that page before relying on either number operationally.
- **Exact `wrangler d1 migrations` subcommand flags and `wrangler dev --test-scheduled` interaction with the `assets` config** — pointed to the right commands and general behavior, but did not verify every flag against the current `wrangler --help` output; a GitHub issue notes friction between `--test-scheduled` and asset-serving configs that should be re-checked at implementation time.
- **Whether Gemini Embedding models have a numerically-defined free-tier quota** — the fetched pricing page indicated a free allowance exists for `gemini-embedding-2-preview` but gave no RPM/RPD/TPD numbers. This is why Section 8 recommends Workers AI's precisely-quantified embedding allocation instead.
- **Reddit and Syndication CDN IP-blocking of Cloudflare Workers egress** (flagged as an open question in the project's own brainstorm contract) — out of scope for this platform-facts research; requires a live probe from an actual Worker, as the contract itself already notes.

## Sources

- Cloudflare Workers: [limits](https://developers.cloudflare.com/workers/platform/limits/), [pricing](https://developers.cloudflare.com/workers/platform/pricing/), [placement](https://developers.cloudflare.com/workers/configuration/placement/), [placement-hints changelog](https://developers.cloudflare.com/changelog/post/2026-01-22-explicit-placement-hints/), [subrequests changelog](https://developers.cloudflare.com/changelog/post/2026-02-11-subrequests-limit/), [wrangler config](https://developers.cloudflare.com/workers/wrangler/configuration/), [vitest integration](https://developers.cloudflare.com/workers/testing/vitest-integration/configuration/), [vitest blog post](https://blog.cloudflare.com/workers-vitest-integration/), [migrate Pages→Workers](https://developers.cloudflare.com/workers/static-assets/migration-guides/migrate-from-pages/), [cron example](https://developers.cloudflare.com/workers/examples/multiple-cron-triggers/)
- Cloudflare Queues: [limits](https://developers.cloudflare.com/queues/platform/limits/), [pricing](https://developers.cloudflare.com/queues/platform/pricing/), [batching/retries](https://developers.cloudflare.com/queues/configuration/batching-retries/)
- Cloudflare Workflows: [limits](https://developers.cloudflare.com/workflows/reference/limits/), [pricing](https://developers.cloudflare.com/workflows/reference/pricing/), [billing changelog](https://developers.cloudflare.com/changelog/post/2026-07-07-workflows-billing-updates/)
- Cloudflare D1: [limits](https://developers.cloudflare.com/d1/platform/limits/), [Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/), [import/export](https://developers.cloudflare.com/d1/best-practices/import-export-data/), [read replication](https://developers.cloudflare.com/d1/best-practices/read-replication/), [query JSON](https://developers.cloudflare.com/d1/sql-api/query-json/), [SQL statements](https://developers.cloudflare.com/d1/sql-api/sql-statements/)
- Cloudflare R2: [pricing](https://developers.cloudflare.com/r2/pricing/)
- Cloudflare Zero Trust/Access: [plans](https://www.cloudflare.com/plans/zero-trust-services/), [seat management](https://developers.cloudflare.com/cloudflare-one/team-and-resources/users/seat-management/)
- Cloudflare AI Gateway: [overview](https://developers.cloudflare.com/ai-gateway/), [pricing](https://developers.cloudflare.com/ai-gateway/pricing/)
- Cloudflare Workers AI: [pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/)
- Cloudflare Vectorize: [pricing](https://developers.cloudflare.com/vectorize/platform/pricing/)
- Cloudflare Community: [Workers in LLM-forbidden locations thread](https://community.cloudflare.com/t/do-not-put-workers-in-llm-forbidden-locations/711754/1)
- Google Gemini API: [rate limits](https://ai.google.dev/gemini-api/docs/rate-limits), [models](https://ai.google.dev/gemini-api/docs/models), [latest model (3.8 Flash)](https://ai.google.dev/gemini-api/docs/latest-model), [structured output](https://ai.google.dev/gemini-api/docs/structured-output), [generate-content API reference](https://ai.google.dev/api/generate-content), [API terms](https://ai.google.dev/gemini-api/terms)
- Google DeepMind model cards: [3.6 Flash](https://deepmind.google/models/model-cards/gemini-3-6-flash/), [3.7 Flash](https://deepmind.google/models/model-cards/gemini-3-7-flash/), [3.8 Flash](https://deepmind.google/models/model-cards/gemini-3-8-flash/)
- Google blog: [3.8 Flash and 3.8 Flash Cyber](https://blog.google/innovation-and-ai/models-and-research/gemini-models/3-8-flash-and-3-8-flash-cyber/), [3.8 Live](https://blog.google/innovation-and-ai/models-and-research/gemini-models/gemini-3-8-live-gemini-3-8-live-extended-thinking/)
- Google Gemini CLI issue (location error, secondary corroboration): [discussion #1663](https://github.com/google-gemini/gemini-cli/discussions/1663)
- Wikipedia (secondary, model-history corroboration only): [Gemini 3 (AI)](https://en.wikipedia.org/wiki/Gemini_3_(AI))

## Unresolved questions (for the plan, not this research)

1. The user must read their own live Gemini RPM/TPM/RPD numbers from `aistudio.google.com/rate-limit` before the daily-budget-ledger design can be finalized — this research could not fetch that authenticated page.
2. Confirm whether Cloudflare Workflows per-step billing is now actually charging (effective date was "no earlier than 2026-08-10", and today is 2026-09-20) — irrelevant if Queues is chosen as recommended, but worth a one-time dashboard check if Workflows is used anywhere.
3. Spot-check `wrangler d1 migrations --help` and `wrangler dev --test-scheduled` behavior with an `assets` block configured, since this research relied on general docs/examples rather than a line-by-line current CLI reference for those two specifics.
