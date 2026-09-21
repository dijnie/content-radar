---
title: "Complete Jobs, News, Hands-on and Deep dives"
status: completed
priority: P1
---

# Complete editorial feeds

## Outcome and scope

Implement all four screenshot surfaces with real D1 data and working controls, retaining Stories and System status. Crawl runs stop after ingestion/deduplication; independently scheduled feed builds reference a completed crawl and can be rerun independently. No sample content, fabricated metrics, new paid service, or production deployment is included.

## Constraints

- Preserve Access, CSRF, existing story actions, source guards, and the owner's DeepSeek budget (100 requests/day, 5/minute).
- Add forward migrations; retain existing data and APIs.
- Record crawl membership and immutable published feed snapshots. Failed builds retain the previous publication.
- Reuse extraction calls for editorial classification and source-grounded Vietnamese summaries. Missing metrics remain explicitly unavailable.
- Adjustable defaults stated after the optional scoring question received no reply: News uses existing story score at threshold 55; toolbox weights 35/25/20/10/10 with documented configurable normalisation. Existing Stories score and DeepSeek budget remain unchanged.

## Phases

1. [Durable crawl and feed jobs](phase-01-jobs.md).
2. [Sources and editorial publication](phase-02-feeds.md).
3. [Reference interfaces and delivery](phase-03-ui-and-verification.md).

## Acceptance

- Jobs: date/failure filters, counts, timings, per-source errors, manual crawl, feed schedules, independent rerun from a completed crawl; duplicates/recovery cannot double-publish.
- News: published-run provenance, recent/7-day selection, threshold and actual voice/platform/engagement/article metadata, source detail.
- Hands-on: toolbox/field tests/playbooks, actual repository snapshots and score breakdown, pagination and source links.
- Deep dives: month windows, unread/read persistence, pillar/sort/search, question/summary/findings, detail and original-source links.
- Desktop/mobile, keyboard, loading/empty/error states verified. Existing story controls retained.
- Meaningful migration, ingestion, publication, API/auth and UI checks pass; full typecheck/test/build and review completed.

## Evidence

Baseline `4097a1e`; inspected app, API router, source adapters, extraction/budget flow, cluster publication and migrations 0001–0009. Prior UI work covered only Stories.

Local delivery checks: 511 tests, full typecheck, web build, Worker dry-run, analyst shell checks, D1 upgrade/FK checks and real-data browser verification passed. [Delivery review](reports/delivery-review.md) records scope, decisions, proof and limitations; [local observations](reports/local-evidence.json) record actual source/publication counts. Production deployment and populated AI categories are not implied by local test success.
