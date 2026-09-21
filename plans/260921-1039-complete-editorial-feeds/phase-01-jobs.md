---
title: "Durable crawl and feed jobs"
status: in-progress
---

# Jobs

Read: `apps/worker/src/ingest/`, `llm/messages.ts`, `api/router.ts`, migrations and queue tests.
Modify: new jobs module/migration/API; ingestion, scheduler and dead-letter integrations.

- [x] Forward schema: crawl runs, source outcomes, item membership, feed runs/publications/schedules.
- [x] Crawl dispatch, idempotent source claims, completion, retry/recovery and manual controls.
- [x] Independent feed run enqueue, lease/publication fencing and scheduling.
- [x] Jobs API, validation, filtering, detail and auth/CSRF tests.

Risk: queue redelivery and partial failure. Persist intent before enqueue, recover from D1, never publish an unfinished run. Rollback: revert application; retain additive schema/data.
