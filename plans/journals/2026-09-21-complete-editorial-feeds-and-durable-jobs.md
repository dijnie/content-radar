---
title: Complete editorial feeds and durable jobs
date: 2026-09-21
summary: "Implemented all four reference surfaces, verified real crawl and Gateway-backed publication locally; production release remains separate."
---

# Complete editorial feeds and durable jobs

## What happened

The existing UI covered Stories. Implemented Jobs, News, Hands-on and Deep dives with D1-backed controls, a forward migration, source snapshots, independently scheduled feed publication, real GitHub Trending and Hugging Face Papers, and editorial metadata in the existing budgeted extraction path.

A local crawl of 121 sources recovered its interrupted final source through the persisted lease, finishing partial with three explicit upstream failures. Initial publications included 33 real repositories and a News topic above threshold. Local direct DeepSeek authentication returned 401; selecting the repository's existing AI Gateway route produced successful extraction and real Deep dives/Playbooks. Kept the 100/day and 5/minute caps and all usage counters. Cleared only the stale configuration-error circuit after changing the local route.

## Verification and decisions

511 tests passed, as did full typecheck, web build, Worker dry run, analyst shell checks, migration upgrade/reapply/FK checks. The final read-detail correction passed focused publication tests and Worker typecheck. Independent frontend simplification preserved behavior. Real desktop/mobile checks covered Jobs filters/errors, Hands-on pagination, News source quotes, populated Deep dives and persisted read/unread across reload, and Playbook cards.

News retains Stories scoring with an adjustable default threshold 55. Repository weights 35/25/20/10/10 use documented configurable normalisation; unknown facts remain unknown. No sample cards were inserted. Existing Stories and user actions remain intact.

## Next steps

Production deployment is outside this implementation: bookmark and migrate D1, sync configuration, deploy, verify authenticated UI and scheduled operation. Observe backlog and D1 snapshot growth during continued operation. The final rebuild also populated Field tests from verified first-hand claims; all new sections now have local source data.

Plan and evidence: [editorial feeds](../260921-1039-complete-editorial-feeds/plan.md), [delivery review](../260921-1039-complete-editorial-feeds/reports/delivery-review.md).

AgentWiki publish skipped; this journal remains local.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
