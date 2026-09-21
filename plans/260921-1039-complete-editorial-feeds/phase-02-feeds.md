---
title: "Sources and editorial publication"
status: todo
---

# Editorial data

Read: `sources/github.ts`, `source-adapter.ts`, extraction prompt/schema/batch, story scoring, configuration schema.
Modify: source metadata, editorial extraction, feed builders/queries, additive settings and tests.

- [x] Preserve real GitHub daily trending rank/stars and repository metadata; never label search order as Trending.
- [x] Store editorial classification, question and Vietnamese summary alongside verified claims using existing budgeted extraction.
- [x] Build News, toolbox/field tests/playbooks and Deep dives snapshots from completed crawls.
- [x] Feed queries, filters, details, read actions and actual metric/provenance aggregation.
- [x] Verify classification validation, missing metrics, snapshot isolation, independent rerun and read-state persistence.

Risk: incomplete provider data. Missing values remain null; feed errors preserve previous publication. No extra paid quota. Rollback: additive data retained, disable new schedules.
