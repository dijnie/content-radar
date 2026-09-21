---
title: Content Radar empty production feed diagnosis
date: 2026-09-21
summary: Production has no claims in the seven-day window; old live items consumed successful extraction calls before Gemini returned 429.
---

# Content Radar empty production feed diagnosis

## Evidence on 2026-09-21 UTC

- User confirmed Cloudflare account sign-in reaches the Content Radar interface, but no story cards appear. Unauthenticated HTTP requests still redirect to Access. No authenticated browser session was available to this investigation.
- Read-only Cloudflare API queries confirmed production D1 `content-radar` has zero stories. The first snapshot contained 1,537 items, 872 queued, 15 extracted, five irrelevant and 16 claims. A later snapshot contained 942 queued items: 452 published within seven days and 490 older. Polling was active, so these are snapshots, not fixed totals.
- All 16 claims were created at 08:01:54 or 08:03:30 UTC from articles published before the seven-day cutoff. Cluster run 1 at 08:05:18 UTC finished successfully with zero eligible claims and zero communities. Claims existed before the run, but none qualified by publication date.
- The latest observed deployment was version `62a4aba2-ee90-472a-a74c-769e482ed850`, 100%, at 08:22:57 UTC. Read-back confirmed D1, queues, Access binding names and the three expected cron schedules. This does not prove an exact source SHA match.
- Gemini logs contained two successful extraction calls, 33 HTTP 503 responses and three HTTP 429 responses. All three models were parked until 2026-09-22 07:00 UTC (14:00 Vietnam time). The stored error is truncated, so this investigation cannot recover the precise quota dimension from those messages. The resume time is application state, not a guarantee of provider recovery.
- Remote `llm_safe_default_rpd` was 100 while checked-in configuration is 20; remote model limits remained NULL. No configuration was overwritten and no counter was reset.

## Cause and affected paths

`apps/worker/src/ingest/poll-consumer.ts` accepts historical timeline/feed items as live work without checking their age. Direct queue messages can therefore spend extraction calls on old articles. `apps/worker/src/llm/drain-backlog.ts:44` also orders by oldest publication first. `apps/worker/src/cluster/cluster-step.ts:9` correctly limits its input to the window defined by `packages/core/src/params.ts:44` (seven days, with no production override). Successful AI work produced no input the story generator could use.

The oldest queued live article in this snapshot was from April 2023. Merely rerunning clustering cannot produce cards from the current 16 claims. Existing local cards belong to the separate local D1 database and are not evidence of production cards.

## Proposed repair and decision boundary

Recommend prioritizing live articles inside the configured clustering window, retaining old articles for later processing. The existing plan explicitly specifies oldest-first processing (`phase-04-llm-extraction-and-budget.md`), and a consumer test names that behavior. Asked the user to choose recent-first, recent-only automatic analysis, or keeping oldest-first. The user subsequently chose recent-first, keeping historical articles for later. This supersedes the original oldest-first policy across the whole live backlog.

A repair must cover both immediate ingestion wake-ups and backlog draining, as changing SQL ordering alone does not control already queued historical messages. Preserve explicit backfill, daily budget shares, Access, graph thresholds and historical data. Validate recent-versus-old scheduling with scarce budget, old-message delivery, retries, configured window overrides and eventual historical processing if that option is accepted. Production card proof still requires successful recent extraction and a completed cluster run.

## References and limits

- Current quota documentation: https://ai.google.dev/gemini-api/docs/rate-limits — quota is per project; daily request limits reset at midnight Pacific. No extra Gemini probe was sent.
- Investigation used production read-only SQL, deployment/configuration read-back, local source and local API inspection. No tests were rerun because runtime code was unchanged.
- Local journal only; AgentWiki publish skipped.

## Repair and local verification

- Added a shared extraction-window policy matching resolved clustering parameters. Live polling stores old articles without immediate wake-ups; backlog draining selects recent work while any remains queued; the consumer acknowledges historical messages without an AI call until that work clears. Backfill remains identifiable and retains its separate budget share. Historical items resume through the normal drain; no migration or data rewrite.
- Seven regression cases cover the seven/fourteen-day boundaries, a mixed batch, historical messages already in the queue, eventual recovery, scarce-budget scheduling and backfill accounting. Before the fix, five cases failed with the historical article being sent/processed first; after the fix, 40 focused tests pass. The 14-day case and backfill accounting also verify compatibility.
- Full Worker suite: 319/319 tests across 37 files. All workspace and script typechecks, web build, Markdown links and `wrangler deploy --dry-run` pass (74 assets, expected six resource bindings). Direct diff review using `ak-code-review`: no blocking issue found; no independent subagent review. Historical work may wait indefinitely under sustained recent demand, as documented for the accepted recent-first policy.
- The implementation does not change quota, model order, graph thresholds, authentication, item publication dates or stored historical data. No additional dev server was started; the user's existing server was left running.
- Deployment and production verification are pending at this commit. A first production card cannot be claimed before recent extraction succeeds and clustering publishes a qualifying story.

## Unresolved questions

- Does the owner intend to keep the remote daily-budget setting at 100 or reconcile it to the checked-in 20? No change proposed until that drift is understood.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
