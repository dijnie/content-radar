# Content Radar reference UI verification

Date: 2026-09-21. Scope: local UI fidelity and visible interactions against [the supplied photo](https://www.facebook.com/photo/?fbid=29387863247481748).

## Result

Completed the reference layout and interaction changes in the existing React application. Real backend contracts and ingestion behavior retained. No product fixtures, source data, or hard-coded counters added.

- Full-width toolbar; light neutral canvas; thin card borders; relative spacing and typography scale at large desktop widths.
- Two equal-height cards per row, with DOM/keyboard order matching ranking; one column at 900px and below.
- Question count opens the real question list inline. Link opens original sources and closes on Escape, outside click, or focus leaving the list. Escape restores trigger focus.
- System status remains available below the feed. Topic `ai` uses the visible label `AI`; keywords unchanged.
- Browser inspection reproduced a source menu extending 55.75px left of the viewport at 901px. Anchoring the menu to the action group fixed it.

## Checks

| Check | Result |
|---|---|
| `npm run test --workspace @radar/web` | 13 passed, including rank/keyboard order, disclosure, menu dismissal, actions/error rollback, and search clearing |
| `npm run test --workspace @radar/worker -- test/api/stories-routes.test.ts test/api/routes-behind-auth.test.ts` | 24 passed; filters, normalized search, sorts, pagination, action persistence, auth/CSRF and static assets |
| `npm run typecheck` | Passed for scripts, core, web, Worker |
| `npm run build --workspace @radar/web` | Passed; final production bundle built |
| `npm run config:sync -- --local` | Applied configured AI label; 3 topics, 119 sources, 13 authors, 12 settings |
| `git diff --check` | Passed |

Browser used the already-running local Worker at `http://127.0.0.1:8787`. No duplicate dev server started. Existing Gemini and Apple Silicon stories came from the local API; requests were not stubbed.

Observed Save → Saved → reload → Written → reload → Restore, then Dismiss → Dismissed → reload → Restore. Final IDs/user states and counts matched the initial snapshot: inbox 2, saved 0, dismissed 0. These checks left normal action-audit entries in local D1.

Also exercised Backend/System Design filtering, empty state, Newest/Score, search, filter persistence through reload, question disclosure, source list, Escape focus return, and System status/back navigation. Unit and D1 tests cover error rollback and pagination; the live local feed only has two cards.

At widths 2048, 1440, 901, 900, 768, 390, 375, 320 and 844px, checked both card menus, page overflow, equal desktop row height, and single-column layout. Checked 200% text size at 390px. Results: [machine-readable measurements](../260921-0954-reference-ui-fidelity/reports/browser-layout-checks.json).

## Visual evidence

- [Desktop 1440px](../260921-0954-reference-ui-fidelity/reports/desktop-1440.png)
- [Desktop 2048px](../260921-0954-reference-ui-fidelity/reports/desktop-2048.png)
- [Mobile 390px](../260921-0954-reference-ui-fidelity/reports/mobile-390.png)
- [Reference screenshot](../260920-0838-content-radar-v1/assets/reference-ui.jpg)

Screenshot focus rings reflect the keyboard checks. Card text, counts, heights and status composition differ from the reference because they show current ingested data. Exact font identity and hidden original behavior cannot be verified from one image.

## Review and limits

Reviewed the complete diff using the frontend accessibility and code-review checklists. No unresolved issue introduced by this change was found. Safe URL filtering, React text rendering, auth, and CSRF contracts remain covered by tests.

Verification tooling notes: empty-string browser `fill` did not dispatch the expected React change; native keyboard clearing and the component test confirmed clearing works. A cached local index briefly referenced replaced build assets; opening a fresh URL loaded the final bundle. These were resolved during verification. No skill code modified.

Not deployed. Production appearance and the original project's hidden workflows are not claimed as verified.

Unresolved questions: none blocking this visible UI scope; exact source font and hidden original behaviors remain unavailable from the image.
