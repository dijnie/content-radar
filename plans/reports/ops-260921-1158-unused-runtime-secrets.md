# Runtime secret cleanup

Date: 2026-09-21. Worker: `content-radar`. Status: completed.

## Scope and evidence

- Inspected live settings, active deployment, downloaded production bundle, local environment contract and call sites. No secret values were exposed or written to this report.
- The live bundle contained no `GEMINI_API_KEY` reference. Deleted this binding through the Worker secret DELETE endpoint; HTTP 200.
- `DEEPSEEK_API_KEY` was already absent when inspected. The only runtime plaintext variable, `AI_GATEWAY_ID`, selects the configured Gateway and remains required.
- Retained five secrets: `ACCESS_AUD`, `ACCESS_TEAM_DOMAIN`, `APP_ORIGIN`, `GITHUB_TOKEN`, `OWNER_EMAIL`.
- Retained `AI`, `ASSETS`, `DB`, `LLM_QUEUE`, `POLL_QUEUE`, `RAW` resource bindings. Gateway provider keys and local ignored credential files were outside this production cleanup.

## Verification

- Before: version `a7975fa4-c370-48cb-881a-ef405341094e`.
- After: version `ce0cded3-c2ea-4e5b-829e-75ceec057be9`, deployment `400ef82a-8173-424d-a657-bdd7e1632b49`, 100% traffic at `2026-09-21T12:03:58.882016Z`.
- Script ETag before and after: `3f01f41e8a3aeeff6c456aad4869065fe89260b0197be235b12a2ecf71384453`. No local source upload.
- All remaining binding objects matched before/after exactly; version runtime settings and script metadata matched. Deployment annotations changed to record the secret operation.
- Anonymous browser-style requests to `/` and `/api/status` returned 302 to the configured Cloudflare Access host. This verifies the authentication boundary, not a completed owner login or a new inference call.
- Documentation-only repository change: whitespace and local documentation links checked. Application test suites were not rerun because no source or local runtime configuration changed.

## Maintenance

Do not recreate Gemini or direct-provider secrets for the active Gateway route. A future return to Gemini must explicitly restore valid provider credentials and verify inference. Deleting a Worker binding does not revoke the provider key itself. See [operations](../../docs/operations.md#deepseek-qua-ai-gateway) and [Cloudflare secret deletion behavior](https://developers.cloudflare.com/workers/configuration/secrets/#delete-secrets-from-your-project).
