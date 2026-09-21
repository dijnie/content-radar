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
