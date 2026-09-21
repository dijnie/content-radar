---
title: "Phase 1: Reference layout and interaction fidelity"
status: completed
---

# Phase 1: Reference layout and interaction fidelity

## Context links

- Reference: [original screenshot](../260920-0838-content-radar-v1/assets/reference-ui.jpg) (2048×1505 raster), reopened from the supplied Facebook URL on 2026-09-21.
- Layout: [`apps/web/src/components/story-grid.tsx`](../../apps/web/src/components/story-grid.tsx), [`apps/web/src/styles.css`](../../apps/web/src/styles.css).
- Content/actions: [`apps/web/src/components/story-card.tsx`](../../apps/web/src/components/story-card.tsx), [`apps/web/src/components/card-actions.tsx`](../../apps/web/src/components/card-actions.tsx), [`apps/web/src/components/toolbar.tsx`](../../apps/web/src/components/toolbar.tsx), [`apps/web/src/app.tsx`](../../apps/web/src/app.tsx).
- Product and security constraints: [`docs/architecture.md`](../../docs/architecture.md), [`plans/260920-0838-content-radar-v1/phase-07-api-and-web-ui.md`](../../plans/260920-0838-content-radar-v1/phase-07-api-and-web-ui.md), [development rules](../../.claude/rules/development-rules.md).

## Measured visual contract

The JPEG has a near-white canvas (dominant corner sample approximately `#fbfdfa`), white card surfaces, a neutral warm-grey control track, and very light grey borders. JPEG resampling makes individual edge samples approximate; use rendered browser screenshots as the final authority.

- Visible content runs from approximately x=26 to x=2021. The first row has card boxes around x=26–1015 and x=1032–2021: about 990 source pixels each with a 16px source-raster gap. The page therefore needs a full-width container; the current 1680px max-width would diverge on the reference-sized viewport.
- The toolbar occupies approximately y=18–78. Its four groups are compact and single-line at the reference width: state x≈26–512, topics x≈528–976, search x≈992–1744, and sort x≈1808–2021. The caption sits below it before the grid.
- The first card row begins around y=135 and ends around y=1111; the next row begins around y=1127. Both cards in each row share the same top and bottom edges. Implement direct grid children with `align-items: stretch`; remove nested independent columns and the misleading comment in `story-grid.tsx`.
- Card content starts about 26–30 source pixels from the edge. The status dot is roughly 29px from the left edge, the entity label follows by one small gap, the headline is indented by roughly 55px from the edge, and the score is right-aligned with a similar inset. Preserve the visual indent while reducing current excessive padding at the 1440 CSS target.

## Typography and sizing guidance

The static image contains no font metadata and cannot establish a device-pixel ratio. Initial inspection suggested narrower/heavier typography, so the following targets were provisional pending browser comparison. Final implementation keeps the existing verified Fira Sans/Fira Mono assets and uses a bounded 16–20px root scale with relative spacing to match the large reference's proportions. No font dependency was added.

- Target at 1440 CSS pixels: base/claim text 16px with 1.45–1.5 line-height; headline about 17px/1.45 at weight 600; entity label about 18px/1.2 at weight 600; status, metadata, and buttons 13–14px; score about 18px; role chips about 12–13px.
- Reduce the current card padding from 24px × 26px toward roughly 16px × 18px, card radius toward 10–12px, and metadata top margin toward 18–20px. Keep claim gaps around 8–10px and footer spacing around 14–16px.
- Keep desktop controls compact (about 38–40px high); retain 44px touch targets on the mobile breakpoint. Use visible `:focus-visible` rings and preserve reduced-motion behavior.

## Implementation steps

1. Flatten `StoryGrid` to map stories directly into one CSS grid; use two columns at the established wide breakpoint, equal row stretch, and one column below it. Preserve array order on mobile.
2. Update `styles.css` tokens/layout to the measured neutral palette, full-width page, compact toolbar, equal rows, card spacing, readable type, and responsive overflow rules. Keep status/notice styles functional.
3. Fold questions disclosure into the metadata line in `StoryCard`; do not render a separate summary row. The count remains visible, and an accessible control/details affordance can reveal the real question list.
4. Make the `Link` trigger plain in `CardActions` even when multiple safe links exist; keep the accessible menu and real URLs, without inventing a new action or data source.
5. Keep the status route reachable from `app.tsx` in a low-visual-weight location, and preserve loading, retry, optimistic rollback, URL filters, source counts, and real API responses.

## Validation

- Run `npm run test -w @radar/web`, `npm run typecheck -w @radar/web`, and `npm run build -w @radar/web`.
- Capture the real local feed at 1440px and 390px; also inspect a 2048×1505 or proportionally equivalent viewport. Compare card edges, row bottoms, toolbar wrapping, text wraps, metadata/footer placement, and horizontal overflow against the reference.
- Tab through toolbar, search, metadata disclosure, link menu, card actions, retry, and status navigation. Exercise Save/Dismiss/Written/Restore and link opening with existing ingested D1 rows; verify action errors restore the prior card state in component tests.

## Verified result

- Direct row grid, inline question-count disclosure, plain Link, dismissible source list, footer status navigation, and configured AI label implemented.
- 13 web tests, 24 API/auth integration tests, root typecheck, and web build pass.
- Existing local stories used for browser actions; Save, Written, Dismiss survived reload and Restore returned both cards/counts to their initial states.
- Nine viewports from 320 to 2048px pass row/column and overflow checks; both source menus stay inside the viewport; 200% text scaling checked.
- [Full verification and screenshots](../reports/ui-260921-0954-reference-ui-fidelity.md). No deployment or assertion of exact hidden reference behavior.

## Unknowns from a static image

The image cannot establish exact font family, browser zoom/DPR, breakpoint, card-menu behavior, question disclosure semantics, action persistence/error handling, loading/empty states, pagination, status navigation, or post-action ordering. Keep those behaviors from the existing contracts/tests and document any visual inference; do not add fake data or functionality solely to fill the screenshot.

## Risks and rollback

- Equal row stretching can make a short card contain unused white space; this is required by the reference and should be limited to desktop rows, with natural height on mobile.
- Font metrics may change wrapping and card height. Tune only after browser screenshots using real content; revert the token-level typography change if it harms Vietnamese glyph rendering or keyboard layout.
