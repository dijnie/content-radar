# Editorial feeds delivery review

Date: 2026-09-21. Scope: complete local implementation of Jobs, News, Hands-on and Deep dives, retaining Stories/System status. Baseline: `4097a1e`. No production deployment or remote migration was performed.

## Implementation

- Additive migration `0010`: durable crawl membership/source snapshots, editorial metadata, repository observations, independent feed schedules/runs, staged publication and persistent read state.
- Queued work remains recoverable in D1. Source/build tokens fence duplicate or stale workers; partial crawls can publish their successful sources; failed builds preserve the previous publication.
- GitHub daily Trending and Hugging Face Papers use public source data. Search discovery never acquires an invented Trending rank. Unknown metrics remain unknown.
- Existing extraction calls return validated editorial metadata and source-grounded Vietnamese summaries. Verified claims survive malformed metadata. Older metadata enrichment remains behind ordinary extraction and uses the existing budget.
- Real API and UI controls cover date/failure filters, source errors, manual crawl, completed-crawl selection, independent builds/schedules, News windows/threshold, three Hands-on categories, pagination, Deep dives windows/read state/pillar/sort/search and original-source details.
- News uses existing Stories scores, default threshold 55. Repository defaults use 35/25/20/10/10 weights; normalisation is explicit/configurable. The optional scoring question received no answer; these defaults were stated in commentary before implementation. Existing Stories scoring and DeepSeek 100/day, 5/minute limits are unchanged.

## Automated verification

| Check | Result |
|---|---|
| Core | 98 tests passed |
| Web | 17 tests passed |
| Worker | 396 tests passed |
| Total | 511 tests passed |
| Full workspace typecheck | Passed |
| Web production build | Passed |
| Worker deployment dry run | Passed; no upload/deployment |
| Analyst query shell checks | All passed |
| Existing local D1 upgrade | Migration 0009 and 0010 applied; repeated apply reports no pending migrations |
| D1 foreign key check | No violations |
| Existing state after upgrade | 2 stories, 77 claims and 5 user actions present before new AI work |
| Staged credential scan | No sensitive environment/database files or credential-pattern matches |
| Documentation local links | No broken links |

Tests exercise lease loss, duplicate delivery, lost-queue recovery, source snapshot isolation, retained publication after staging failure, News item-level aggregation/claim membership, threshold and time windows, same-day Trending precedence, metadata validation/budget usage, extraction priority across overlapping crawl windows, read persistence, literal search escaping, schedule bounds and route authentication/CSRF.

## Review

Controller reviewed contracts using `ak-code-review`: data provenance, publication boundaries, filters, mutations, auth/CSRF, budget and recovery. This is an inline review, not an independent security audit. The cook simplifier ran independently on five frontend files; web tests/typecheck passed afterwards.

Issues found and fixed during implementation: invalid metadata must not discard valid claims; a new crawl must not starve previously collected items; later Search observations must not erase real same-day Trending rank; News findings must belong to the displayed story and interactions must not multiply per claim; crawl completion time must include the final source's elapsed work; a read action removing the last item must clamp pagination; the entry detail API must overlay persisted read state just like the list API. The final read-detail correction passed the focused feed-publication tests and Worker typecheck.

## Browser and source verification

Browser session `editorial-d03fb71a137d` reused the existing Worker at `127.0.0.1:8787`. Desktop 1440px and mobile 390px checked. Jobs source-error expansion, navigation, keyboard focus and empty feed states work without horizontal overflow or browser errors. Screenshots in this directory are from the real local database; no sample records were inserted.

The manual crawl recovered Hugging Face Papers after lease expiry without any manual D1 state changes. It completed `partial`: 121 sources, 1,465 posts, 343 articles, 1,555 new items. The 3 source failures were Marc Brooker RSS (timeout), Hugging Face Transformers releases and DuckDB releases (existing body-size guard). Hugging Face Papers succeeded on attempt 2 with 50 real abstracts; GitHub Trending succeeded.

Independent builds from crawl #1 succeeded: Hands-on #1 published 33 repositories, News #2 published 2 topics (1 above threshold 55 in the inspected view), Deep dives #3 published an empty result with 1,035 source items awaiting editorial analysis. These counts are observations, not fixed product data. Deep dives and Playbooks were subsequently rebuilt with live AI classifications; final observations below supersede the initial empty publication. Field tests initially remained empty until qualifying first-hand claims were classified. The final rebuilt feed also has real Field test cards; see the final observations below.

Browser checks with the published records: Hands-on page 2 starts at rank 7, changing to Field tests resets pagination and shows its true empty state, switching back returns rank 1; Jobs failures-only leaves the partial crawl; News details expose two original sources and verified quotes. Real repository cards have no mobile horizontal overflow. Two existing Stories and their actions remain present. No browser errors were reported. See `local-evidence.json` and desktop/mobile screenshots. Some automation selectors initially timed out; direct selectors succeeded and no application defect was reproduced.

## Operational boundaries

The Worker-local environment initially lacked the existing DeepSeek credential stored at the repository root. It was copied into the ignored local environment without logging its value, and the dev configuration reloaded. The direct key returned HTTP 401 on a real budgeted extraction. Local was then configured with `AI_GATEWAY_ID=gateway`, reusing the production Gateway binding and its existing BYOK provider key. After changing the route, only the configuration-error circuit was cleared; usage counters, 100/day and 5/minute limits, retry attempts and model cooldown were preserved. The Gateway produced successful budgeted extractions (26 and 28 quote-validated claims in the first two successful calls) and real deep-dive/playbook metadata. An incomplete response was recorded and recovered through the existing retry path. No production secret or deployment was changed.

Production release remains outside this task: bookmark D1, apply the new forward migration and sync configuration, deploy, verify Access with the owner's browser, then observe scheduled operation. Feed/crawl snapshot history currently remains retained; monitor D1 size during continued operation.


## Final populated UI proof

Gateway-backed analysis populated Deep dives build #7 with four real articles, and Hands-on build #8 with 34 toolbox entries plus three Playbooks. On a real Deep dives article, Mark as read moved it to Read, a full browser reload preserved the state, and Mark as unread restored it. Both populated Deep dives and Hands-on remain within the 390px viewport; desktop screenshots use 1440px. Real Playbook cards render source-grounded Vietnamese summaries. The local environment now uses the existing Gateway route; the failed direct key is not the active route.

The final cluster #4 completed successfully with 218 claims, 43 edges and 16 communities. News was rebuilt from crawl #1 afterwards; final publication counts are recorded in `local-evidence.json`.

Final Hands-on and Deep dives were rebuilt once more after the backlog produced verified Field tests. All three Hands-on categories and Deep dives now have actual local source data. The exact counts and publication IDs are in `local-evidence.json`; `field-tests-desktop.png` records the populated category.
