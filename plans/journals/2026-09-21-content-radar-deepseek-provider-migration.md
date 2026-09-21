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

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
