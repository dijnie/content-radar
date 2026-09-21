# Route DeepSeek through the existing AI Gateway

## Outcome and scope

Owner approved the AI binding route on 2026-09-21. Use account `67a5d5c1b4057035786e297885f16a82`, gateway `gateway`, provider `deepseek`, stored key alias `default`. Keep existing alias `deepseek`. Preserve model `deepseek-flash`, thinking disabled, local schema/quote validation, 100/day and 5/minute, 7-day priority and all history. No Unified Billing or provider/model fallback.

## Evidence and choice

Use the existing `AI` binding and `AI_GATEWAY_ID=gateway`; `env.AI.gateway("gateway").run()` authenticates internally, so no CF_AIG_TOKEN is required. The attempted AI.run route only consults alias `default`. Owner approved adding this alias and enabling Require provider credentials. The preceding HTTP implementation at a646b56 was locally tested but never deployed; its token requirement is superseded.

Duplicated the existing secret inside Secrets Store without reading its value: `gateway_deepseek_default`, scope `ai_gateway`. Gateway provider config creation with `secret_id` returned 7001 despite the active named secret; creation without that optional field succeeded. Runtime resolves the documented secret name. `byok_only=true` verified, with all other editable Gateway settings unchanged. Real extraction and synthesis below verified the configuration.

## Implementation and acceptance

- Provider binding transports the same JSON task, disables thinking and returns a raw Response to retain status, Retry-After and usage.
- No tokens or provider keys sent by the Worker in binding mode; no HTTP fallback if the binding is missing.
- One upstream attempt, cache bypass, 60-second timeout across response/body and per-request no-wholesale header.
- Missing binding or invalid Gateway configuration parks work without failing articles. Gateway 400 parks because missing BYOK uses that status; inspect Gateway logs for parameter errors.
- Focused tests, complete Worker suite, root typecheck, dry-run and inline review. Deploy a tagged revision; verify Gateway log and one real budgeted pipeline result. Never reset usage.

## Rollback

Restore direct code and its matching configuration only with a valid direct key. The local direct key currently returns 401. Keep model selection, usage, claims, stored aliases and Gateway credential requirement; rollback alone cannot repair invalid credentials.

## Status

Complete: final provider binding passed 52 focused tests, all 354 Worker tests, root typecheck and deployment build. Inline review and independent simplification/transport review found no remaining blocker; simplifier made no edits. Tagged deployment serves 100% traffic, and real budgeted extraction and synthesis matched successful Gateway logs. Earlier local remote-binding and management API preflights did not establish inference proof; production evidence below does.

## Live correction

Deployed `fd42792` as version `6eff0ccd-c64a-4435-bba2-5664b726312f`. Read-back confirmed AI and AI_GATEWAY_ID, 100% traffic; unauthenticated root/status/probe all redirect to Access. A real queued batch produced D1 call 45, HTTP 404. Gateway log `2d8df535a54e460953f6e0f7cd94032fb4dc589439f14a6714a1a44614bdc48a` says `Model not found: deepseek/deepseek-flash`, provider unknown, wholesale false. No articles failed and circuit paused.

Corrected the implementation to the existing provider binding `AI.gateway(id).run()` with one DeepSeek request and no fallback array. It returns raw Response and supports signal/gateway options. The selected model/key are preserved without the AI.run catalog restriction. This uses the deprecated Universal transport still implemented by Cloudflare; the maintenance limitation was disclosed to the owner. No dynamic route, HTTP token or secret export was needed.

## Provider binding verified

Version `16b791cd-05cc-4f10-b7fe-5cb55dacc56f` (tag `51f7dd6`) serves 100% traffic. Real extraction call 46 processed ten items, accepted 19 claims, and matched Gateway log `01M31NEGEBC5272T7YPJTXNHY9` with HTTP 200, identical token usage, cache false and wholesale false. Synthesis call 47 updated one existing card with an LLM headline and five verification questions, matching Gateway log `01M31NK39T7WADN4FZMTH6VHQE` with the same success/cache/billing flags. All 9 daily requests remain accounted for; no configuration circuit remains. Access redirects remain enforced. See [live evidence](reports/production-verification.md).
