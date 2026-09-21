---
title: "Content Radar reference UI fidelity"
status: completed
priority: P1
---

# Content Radar reference UI fidelity

## Outcome

Bring the existing React feed visually in line with the [reference image](../260920-0838-content-radar-v1/assets/reference-ui.jpg) while preserving real D1 data, API contracts, filter state, optimistic actions, keyboard access, and the system-status route.

## Evidence

- The supplied reference is a 2048×1505 JPEG; measurements below are source-raster pixels, not asserted CSS pixels or device-pixel-ratio conversions.
- The feed uses a full-width light canvas, compact toolbar, two equal-width columns, thin neutral borders, and row-aligned equal-height cards.
- Before this change, `story-grid.tsx` created independent columns, `story-card.tsx` rendered a separate questions disclosure row, and `card-actions.tsx` exposed a link count in the trigger.

## Phase

1. Completed: [Reference layout and interaction fidelity](./phase-01-reference-ui.md).

## Result

Local delivery complete on 2026-09-21. [Verification report](../reports/ui-260921-0954-reference-ui-fidelity.md) records tests, real-data browser actions, nine viewport checks, screenshots, and the production boundary. This change has not been deployed.

## Acceptance criteria

- At 1440px desktop, cards form a direct two-column row grid and row bottoms align; at 390px, the feed is one column with ranked order preserved and no horizontal overflow.
- Toolbar, cards, metadata, buttons, colors, typography, and spacing match the measured reference proportions without fabricating content.
- Questions remain available through an accessible metadata disclosure; the static view has no extra questions summary row.
- Link, Save, Dismiss, Written/Restore, safe URL handling, retry/error UI, filters, counts, pagination, and status access still work against real data.
- `npm run test -w @radar/web`, `npm run typecheck -w @radar/web`, and `npm run build -w @radar/web` pass; browser checks cover 1440px, 390px, keyboard focus, and the original aspect ratio.

## Dependencies

- Existing contracts and implementation in `apps/web/src/`.
- Reference asset and product constraints in `plans/260920-0838-content-radar-v1/phase-07-api-and-web-ui.md` and `docs/architecture.md`.
