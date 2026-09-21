# Route DeepSeek through the existing AI Gateway

## Outcome and scope

Owner approved the AI binding route on 2026-09-21. Use account `67a5d5c1b4057035786e297885f16a82`, gateway `gateway`, provider `deepseek`, stored key alias `default`. Keep existing alias `deepseek`. Preserve model `deepseek-flash`, thinking disabled, local schema/quote validation, 100/day and 5/minute, 7-day priority and all history. No Unified Billing or provider/model fallback.

## Evidence and choice

Use the existing `AI` binding and `AI_GATEWAY_ID=gateway`; `env.AI.run()` authenticates internally, so no CF_AIG_TOKEN is required. Official docs say this path only consults alias `default`. Owner approved adding this alias and enabling Require provider credentials. The preceding HTTP implementation at a646b56 was locally tested but never deployed; its token requirement is superseded.

Duplicated the existing secret inside Secrets Store without reading its value: `gateway_deepseek_default`, scope `ai_gateway`. Gateway provider config creation with `secret_id` returned 7001 despite the active named secret; creation without that optional field succeeded. Runtime resolves the documented secret name. `byok_only=true` verified, with all other editable Gateway settings unchanged. Real inference verification is required before claiming this configuration works.

## Implementation and acceptance

- Binding transports the same JSON task, disables thinking and uses a raw Response to retain status, Retry-After and usage.
- No tokens or provider keys sent by the Worker in binding mode; no HTTP fallback if the binding is missing.
- One upstream attempt, cache bypass, 60-second timeout across response/body and per-request no-wholesale header.
- Missing binding or invalid Gateway configuration parks work without failing articles. Gateway 400 parks because missing BYOK uses that status; inspect Gateway logs for parameter errors.
- Focused tests, complete Worker suite, root typecheck, dry-run and inline review. Deploy a tagged revision; verify Gateway log and one real budgeted pipeline result. Never reset usage.

## Rollback

Restore direct code and its matching configuration only with a valid direct key. The local direct key currently returns 401. Keep model selection, usage, claims, stored aliases and Gateway credential requirement; rollback alone cannot repair invalid credentials.

## Status

Implementation complete: 52 focused tests and all 354 Worker tests passed; root typecheck and production dry-run passed. Inline review and independent simplification review found no remaining blocker; simplifier made no edits. The local remote-binding preflight did not complete and was stopped with its child processes; management API inference returned authentication error 10000, so neither is live inference proof. Production deployment and budgeted pipeline/Gateway proof pending.
