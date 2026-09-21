---
title: Replace Gemini with DeepSeek
status: in-progress
priority: P1
created: 2026-09-21
---

# Outcome

Use DeepSeek for extraction, synthesis and entity adjudication on Content Radar. Preserve recent-first processing, verifiable quotes, historical records, Access and existing graph behavior. No Gemini fallback, new SDK, fake production data or quota reset.

## Execution

1. Inspect provider contracts and current official docs — done.
2. [Implement and validate the provider switch](phase-01-provider-switch.md) — done locally; 444 tests, typecheck, build and Worker dry-run passed.
3. Configure the key and accepted application limits; migrate/deploy; verify a real recent-item run — done: production returned 69 accepted claims and created 5 cards.
4. [Route through the owner-selected AI Gateway](phase-02-ai-gateway.md) — implemented and verified locally; deployment awaits CF_AIG_TOKEN.

## Acceptance

- DeepSeek JSON calls, bounded output/timeouts and actionable error handling.
- 429 waits briefly; missing/invalid key or balance does not fail queued articles.
- New forward migration retains Gemini usage/claims and selects DeepSeek only.
- Existing pipeline behavior and priority regression tests pass; build/typechecks pass.
- Live model/key/config read-back and real recent claims/cards when credentials permit.

## Decisions

- User requested DeepSeek instead of Gemini.
- Recommended `deepseek-flash`, thinking disabled, for bounded JSON tasks. Verified current official model name and pricing.
- Owner supplied the key via root `.dev.vars`; it was uploaded securely to the Worker. Confirmed 100 requests/day and 5/minute for automated work; preserve existing 80/20 extraction/synthesis split. No paid calls until the secret is present.

## Verification

- Focused provider/consumer/cluster/API tests: 90 passed.
- Full suite: core 98, web 10, Worker 336 passed. Test provider envelopes are explicitly synthetic; historical Gemini payload remains labelled historical.
- Forward migration from 0001–0008 tested in SQLite with foreign keys enabled: existing items, claims, calls and usage unchanged; Gemini limits/cooldowns preserved; only DeepSeek enabled at 5/100; unrelated settings preserved and old circuit removed.
- Inline review covered HTTP/error handling, rollout ordering, Access boundary and budgets; no remaining blocking finding. No independent agent review was run.
- Production version `d3d3d40d-6999-42c0-9096-24c377b94266` (tag `1733bd3`) deployed; migration 0009 applied. Four direct API calls succeeded, accepting 69 claims; cluster run 2 published 5 cards. A later direct request returned 401 and paused processing. See [live evidence](reports/production-verification.md).
- Owner then selected existing authenticated Gateway `gateway`, DeepSeek BYOK alias `deepseek`. Preserve it and use provider-native passthrough; no Unified Billing or model changes. Current API connection cannot manage account tokens (9109); owner must provide CF_AIG_TOKEN.
- Gateway checks: 31 focused tests and all 345 Worker tests passed; root typecheck, production dry-run, documentation links and diff whitespace passed. Inline transport/budget/config review found no remaining blocker. No Gateway deployment or live Gateway call yet.

Sources: [API](https://api-docs.deepseek.com/), [JSON output](https://api-docs.deepseek.com/guides/json_mode), [limits](https://api-docs.deepseek.com/quick_start/rate_limit), [pricing](https://api-docs.deepseek.com/quick_start/pricing).
