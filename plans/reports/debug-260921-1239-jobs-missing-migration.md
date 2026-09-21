# Jobs production recovery

Date: 2026-09-21. Scope: repair `GET /api/jobs?days=7&failures=0&page=1` returning 500.

## Cause

- Cloudflare telemetry recorded `D1_ERROR: no such table: crawl_runs` on Worker version `ce0cded3-c2ea-4e5b-829e-75ceec057be9`, matching the reported version. This version was deployed at 12:03:58 UTC.
- Remote D1 had migrations `0001`–`0009`; none of the five Jobs tables existed. The timezone setting was valid JSON.
- Wrangler independently listed only `0010_editorial_feeds.sql` as pending. The existing Jobs handler requires that migration. The deployment command builds/uploads but does not apply D1 migrations.

## Repair

Used the existing additive migration without changing application code, migration contents, Worker version, Access configuration, source configuration, or LLM limits.

From `apps/worker`:

```bash
npx wrangler d1 time-travel info content-radar --json
npx wrangler d1 migrations apply content-radar --remote
npx wrangler d1 migrations list content-radar --remote
```

Pre-change Time Travel bookmark: `00000011-0000063d-000050ed-169a46397ebde953c3545e026c64f39c`.

Wrangler 4.135.0 applied 18 statements successfully. The migration ledger records `0010_editorial_feeds.sql` at `2026-09-21 12:41:14` UTC. No migrations remain pending. Keep this applied migration immutable; future schema changes require new files. The bookmark is an emergency recovery reference, not a recommendation to restore and discard subsequent writes.

## Verification

- `npm test --workspace @radar/worker -- test/jobs/jobs-routes.test.ts`: 3/3 tests passed against local workerd/D1.
- Replayed all four Jobs queries against remote D1 with the reported filters: list/count succeeded with zero historical jobs; all three feed schedules returned; timezone parsed as `Asia/Ho_Chi_Minh`.
- All ten migration tables exist; the new `items.editorial_attempts` column is zero for all existing items.
- Before/after counts unchanged: 1,798 items, 1,129 claims, 91 stories, 119 sources. `PRAGMA foreign_key_check` returned no violations before and after.
- Cloudflare fetch logs at **12:41:50.759** and **12:41:52.134 UTC** show the exact reported Jobs URL returning **200**, still on version `ce0cded3-c2ea-4e5b-829e-75ceec057be9`.

No new development server was started. Existing user-owned local dev processes were left running.

## Remaining boundaries

The reported API error is repaired on production. Jobs has no historical runs because the tables were absent. Remote source configuration remains at 119 sources; the separate local editorial implementation has 121. No config sync, crawl, paid inference probe, or feed build was triggered for this repair. Production scheduled crawl/build and populated-feed acceptance remain separate checks.

References: [operations](../../docs/operations.md), [migration](../../apps/worker/migrations/0010_editorial_feeds.sql), [Jobs handler](../../apps/worker/src/api/jobs-routes.ts), [Cloudflare migrations](https://developers.cloudflare.com/d1/reference/migrations/), [Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/).
