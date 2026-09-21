---
title: Content Radar DeepSeek provider migration
date: 2026-09-21
summary: DeepSeek replacement validated locally; production awaits the Worker secret
---

# Content Radar DeepSeek provider migration

## Request and decisions

Replace Gemini with DeepSeek for all three LLM tasks. Owner confirmed 100 automated requests per Pacific day and 5/minute, and will add `DEEPSEEK_API_KEY` directly on the Cloudflare Worker. Keep the accepted recent-first 7-day policy and historical data.

## Implementation

Direct Chat Completions client for `deepseek-flash`, explicit thinking disabled, JSON object output, schema guidance, local validation, 8,192 output tokens and 60-second timeout. 429 uses short bounded backoff; missing/invalid key or insufficient balance pauses work for 15 minutes. Empty/truncated output retries then parks in D1. No Gemini fallback. Forward migration disables old models without deleting their usage/calls/claims, enables Flash at 5/100 and clears the old circuit. Updated probe, prompts, status labels and owning docs.

## Evidence

90 focused tests passed, then complete suite 444/444 (core 98, web 10, Worker 336). Typecheck, web build and Wrangler production dry-run passed. SQLite forward migration from 0001–0008 preserved seeded items/claims/calls/usage, old model limits/cooldowns and unrelated settings; foreign-key check clean. Inline review completed; no independent agent review. Test DeepSeek envelopes are synthetic and historical Gemini recordings remain clearly labelled.

## Delivery boundary

Remote secret-name inspection found no DeepSeek key. No DeepSeek deployment, remote migration or paid request made yet. Prior production Worker version is `d26e9daf-c9ee-48e3-aba8-628f65f0ca18`. After key exists: deploy code, apply 0009, read back model/caps/version, verify real recent claims and cluster cards. Rollback code and enabled-model selection together, retaining old quotas/history; do not revert D1.

AgentWiki publish skipped.

## Continuation: production and Gateway

Owner later supplied the direct key through root `.dev.vars`. Deployment tagged `1733bd3` and remote migration 0009 were verified; four real calls accepted 69 claims and cluster run 2 published 5 cards. A later direct call returned 401; its cause remains unverified. See [production evidence](../260921-0840-deepseek-migration/reports/production-verification.md).

Owner selected existing AI Gateway `gateway`, stored DeepSeek alias `deepseek`. Added authenticated provider-native routing without sending the direct key, with one upstream attempt and cache bypass per application request. Preserve model, caps and priority. Missing Gateway token fails before HTTP without falling back. Focused tests 31/31, Worker tests 345/345, typecheck and production dry-run passed. Local integration is complete; token `CF_AIG_TOKEN` and live Gateway verification remain pending because the current Cloudflare API connection cannot manage authentication tokens (9109). Explained the two credentials and root `.dev.vars` handoff to the owner. No Gateway deployment yet.

## Continuation: owner-approved AI binding

Owner requested the R2-style binding and approved `env.AI.run()` with default DeepSeek alias and Require provider credentials. Removed the un-deployed HTTP Gateway token transport, reused existing AI binding and set AI_GATEWAY_ID. Raw responses preserve status, Retry-After and token usage; one attempt, cache bypass, timeout and no-wholesale enforced. Gateway 400 parks rather than failing queued articles. Existing direct local mode remains explicit.

Duplicated the provider secret inside Secrets Store and created the default provider config without exporting the key. Gateway `byok_only=true` verified with no other settings changed. The optional secret_id field caused API 7001; omitting it allowed config creation, while documented runtime lookup uses secret name. Local remote-binding probe was stopped after hanging; management inference API lacked permission (10000). These checks did not establish successful inference.

52 focused tests and all 354 Worker tests passed, root typecheck and dry-run passed. Independent simplification review clean; inline review repaired request-count handling for an unexpected parsed binding response and added per-request no-wholesale. Deployment/live pipeline verification follows.

## Live model-catalog correction

The first binding deployment (fd42792, version 6eff0ccd-c64a-4435-bba2-5664b726312f) safely parked a real batch with HTTP 404. Gateway log explicitly reported `Model not found: deepseek/deepseek-flash`; no wholesale billing. Switched the transport to `AI.gateway(id).run()` with explicit DeepSeek provider/model and the same safeguards. The Universal transport is deprecated but still implemented; disclosed this maintenance limitation. Focused 52 tests, all 354 Worker tests, root typecheck and whitespace checks passed for the correction. Live proof pending.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
