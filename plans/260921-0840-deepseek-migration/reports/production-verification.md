# DeepSeek production verification — 2026-09-21

## Deployment

- Owner supplied `/home/dijnie/project/persional/content-radar/.dev.vars`; parsed DEEPSEEK_API_KEY and passed it to Wrangler via stdin. Read-back confirmed secret binding; no value printed.
- Worker version `d3d3d40d-6999-42c0-9096-24c377b94266`, deployment `ef57142e-6016-4de6-a435-5b49b8f7ed05`, tag `1733bd3`, 100%, 09:02:10 UTC.
- Pre-migration D1 bookmark: `00000004-000000fa-000050ed-3a597a77202374925a1d3b9529c977d9`.
- Applied only `0009_deepseek_models.sql`; read-back: DeepSeek enabled at RPM 5/RPD 100; all three Gemini models disabled with cooldowns unchanged.
- Root, status, stories and actual JS asset return 302 to Access without login. workers.dev enabled, preview URLs disabled. Authenticated browser not inspected.

## Real pipeline

At 09:03:10 UTC, sent 50 existing queued item IDs from the current 7-day window through the trusted Cloudflare Queues API to `radar-llm`, in normal live/oldest priority. No source data or cards fabricated; normal budget and validation applied.

- Four DeepSeek extraction calls returned HTTP 200, 69 claims accepted.
- First two calls: 12,205ms / 17 accepted claims; 13,754ms / 19 accepted claims. Model `deepseek-flash`, prompt version 2.
- Hourly cluster run 2 finished with 69 nodes, 5 communities, no error; D1 has 5 alive cards.
- A subsequent direct extraction returned HTTP 401 at epoch 1789981459; configuration circuit opened until 1789982359. No claim that the key remains valid; the cause of revocation/invalidity is unverified.

## Gateway continuation

Owner selected existing authenticated gateway `gateway`; API inspection confirms provider `deepseek`, alias `deepseek`, key reference present. Gateway migration is tracked in [phase 2](../phase-02-ai-gateway.md). The direct deployment and real-card proof above remain valid historical evidence, separate from pending Gateway proof.

## AI binding rollout

Owner approved native binding and default BYOK alias. Duplicated `gateway_deepseek_deepseek` to `gateway_deepseek_default` inside Secrets Store without exporting its value; enabled `byok_only` and verified no other editable Gateway setting changed. Provider config creation with optional secret_id failed 7001; name-based creation without it succeeded.

Version `6eff0ccd-c64a-4435-bba2-5664b726312f`, deployment `4b7ece12-4e19-42d7-81f3-4e5ad43f224d`, tag `fd42792`, 100%, 09:35:10 UTC. AI binding and AI_GATEWAY_ID=gateway present; no Gateway HTTP token needed. Root/status/admin probe returned 302 to Access.

At 09:36:01 UTC requeued ten existing recent items (105,108,141,154,160,165,169,174,175,177), after removing only the previous configuration-error circuit. D1 call 45 returned HTTP 404; Gateway log `2d8df535a54e460953f6e0f7cd94032fb4dc589439f14a6714a1a44614bdc48a` reports `Model not found: deepseek/deepseek-flash`. Its wholesale flag is false. Items preserved; usage retained and circuit opened. Correction to provider binding is pending live verification.
