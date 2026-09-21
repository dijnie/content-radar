# Provider switch

## Scope

Replace the Gemini HTTP client and env bindings with DeepSeek Chat Completions. Keep budget reservation, bounded retry, quote/schema validation and three consumers. Preserve Pacific-day accounting as an application policy, not a claimed DeepSeek quota reset.

Affected: `apps/worker/src/llm/`, `src/env.ts`, `src/api/admin-probe.ts`, migration `0009`, worker tests, web status labels, setup/limit scripts, example vars and owning docs. Historical migrations/recordings remain unchanged.

## Steps

- Implement bearer authentication, explicit non-thinking JSON output, schema guidance, output cap, token usage and error classification.
- Treat 429 as temporary concurrency pressure. Park config/balance errors without failing items. Bound empty/truncated-output retries.
- Add forward model activation preserving old model usage and claims. Ensure deployment before activation cannot send Gemini model IDs to DeepSeek or fail queued work.
- Adapt fixtures to the new transport without describing synthetic data as a real DeepSeek response.
- Verify targeted tests, whole Worker suite, web label tests, typecheck and build; review cross-module diff.
- Configure secrets without exposing values, apply the migration and deploy only when prerequisites are complete. Verify the deployed version and real pipeline separately.

## Risks and rollback

- DeepSeek is paid; cap automated requests and output. Request caps are not guaranteed dollar caps.
- JSON mode guarantees JSON, not the application schema; retain validation.
- Old Gemini cooldown/circuit state must not block the new model.
- Rollback requires restoring the previous enabled-model selection as well as the Worker version. Do not roll back D1 or erase history.

## Execution evidence

Local implementation and checks complete; see [plan](plan.md#verification). `0009` uses the accepted 5 RPM/100 RPD explicitly, so config sync cannot silently reduce the model to the unrelated fallback default. Production code was deployed before migration 0009. Four direct calls accepted 69 claims and the hourly cluster published 5 real cards. A later direct request returned 401 and paused the pipeline. [Live evidence](reports/production-verification.md); gateway routing is the next accepted change.
