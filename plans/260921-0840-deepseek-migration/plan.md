---
title: Replace Gemini with DeepSeek
status: completed
priority: P1
created: 2026-09-21
---

# Outcome

Use DeepSeek for extraction, synthesis and entity adjudication on Content Radar. Preserve recent-first processing, verifiable quotes, historical records, Access and existing graph behavior. No Gemini fallback, new SDK, fake production data or quota reset.

## Execution

1. Inspect provider contracts and current official docs — done.
2. [Implement and validate the provider switch](phase-01-provider-switch.md) — done locally; 444 tests, typecheck, build and Worker dry-run passed.
3. Configure the key and accepted application limits; migrate/deploy; verify a real recent-item run — done: production returned 69 accepted claims and created 5 cards.
4. [Route through the owner-selected AI Gateway](phase-02-ai-gateway.md) — done: native provider binding deployed, real extraction and synthesis verified; no CF_AIG_TOKEN required.

## Acceptance

- DeepSeek JSON calls, bounded output/timeouts and actionable error handling.
- 429 waits briefly; missing/invalid key or balance does not fail queued articles.
- New forward migration retains Gemini usage/claims and selects DeepSeek only.
- Existing pipeline behavior and priority regression tests pass; build/typechecks pass.
- Live model/key/config read-back and real recent claims/cards when credentials permit.

## Decisions

- User requested DeepSeek instead of Gemini.
- Use `deepseek-flash`, thinking disabled, for bounded JSON tasks. Verified current official model name and pricing.
- Owner confirmed 100 requests per Pacific day and 5/minute for automated work; preserve the existing 80/20 extraction/synthesis allocation and usage history.
- Owner selected Gateway `gateway` with a stored DeepSeek key, then approved native binding, alias `default` and Require provider credentials. Preserve the original alias `deepseek`; no Unified Billing.
- Use `AI.gateway(id).run()` because a real `AI.run()` request rejected the selected model. This uses Cloudflare's deprecated Universal transport; the maintenance limitation is documented in phase 2 and operations docs.

## Verification

- Initial provider switch: 90 focused tests and all 444 tests (core 98, web 10, Worker 336) passed, plus typecheck, web build and Worker dry-run. Test provider envelopes are explicitly synthetic; historical Gemini payload remains labelled historical.
- Forward migration from 0001–0008 tested in SQLite with foreign keys enabled: existing items, claims, calls and usage unchanged; Gemini limits/cooldowns preserved; only DeepSeek enabled at 5/100; unrelated settings preserved and old circuit removed.
- Final provider binding: 52 focused tests, all 354 Worker tests and root typecheck passed. Deployment build passed. Inline review and independent simplification/transport review found no blockers.
- Current production version `16b791cd-05cc-4f10-b7fe-5cb55dacc56f` (tag `51f7dd6`) serves 100% traffic. Binding extraction processed ten real recent items and accepted 19 claims; synthesis produced an LLM headline and five verification questions for one existing card. Both calls matched successful Gateway logs with `cached=false` and `wholesale=false`.
- D1 contains 5 alive cards, the configuration circuit is closed, and the DeepSeek daily ledger retains all 9 requests. Anonymous root, status and actual JS asset requests still redirect to Access. No authenticated browser inspection or full-project soak completion is claimed. See [live evidence](reports/production-verification.md).

Sources: [API](https://api-docs.deepseek.com/), [JSON output](https://api-docs.deepseek.com/guides/json_mode), [limits](https://api-docs.deepseek.com/quick_start/rate_limit), [pricing](https://api-docs.deepseek.com/quick_start/pricing).
