# Route DeepSeek through the existing AI Gateway

## Outcome and scope

Use account `67a5d5c1b4057035786e297885f16a82`, gateway `gateway`, provider `deepseek`, stored key alias `deepseek`. Preserve model `deepseek-flash`, thinking disabled, local schema/quote validation, 100/day and 5/minute, 7-day priority and all history. No Unified Billing, provider fallback, or changes to other gateway users.

## Evidence and choice

Gateway GET confirmed authentication enabled, log collection enabled, 50 requests/60 seconds and the DeepSeek alias. Provider-native endpoint supports the existing Chat Completions body and explicit `cf-aig-byok-alias`. The newer AI.run binding consults only alias `default` before Unified Billing, so it does not match this configured key. Keep the alias and use the documented authenticated provider endpoint.

Current Cloudflare API connection returns 9109 for account token permissions. No token created; owner has been asked to supply CF_AIG_TOKEN through root .dev.vars or the Worker secret. No secret values in code, logs or reports.

## Implementation and acceptance

- Extend existing client/env/probe; production config names endpoint and alias.
- Gateway requests carry only CF_AIG_TOKEN, never the direct DeepSeek key. Reject missing token or wrong gateway URL before HTTP, never silently fall back.
- One gateway upstream attempt per reserved request; skip cache; retain application retry and timeout.
- Test credentials/alias routing, wrong-host protection, missing-token behavior and budget accounting. Then Worker suite, typecheck and dry-run.
- Upload token, deploy tagged revision, verify Gateway log plus D1 call/claim. Clear only the stale configuration circuit once valid credentials are configured; never reset usage.

## Rollback

Restore previous code and its matching direct endpoint configuration with a valid DeepSeek key. Keep model selection and all usage/claim data. Previous direct key returned 401; a code rollback alone does not repair credentials.

## Local verification

31 focused transport/provider-availability tests passed, followed by all 345 Worker tests. Root typecheck and production Wrangler dry-run passed; bundle includes the expected Gateway URL and alias. Documentation links and diff whitespace checks passed. Inline review covered credentials, routing, request accounting and rollout; no independent agent review. Direct API credentials remain optional for local operation. No secret values committed.

## Pending

CF_AIG_TOKEN, production deployment and live Gateway proof. Root `.dev.vars` did not contain a nonempty token at the final local check. Gateway code has not been activated on production.
