# ADR-0004: Mobile-first frontend, day one

## Status

Accepted

## Context

A non-trivial fraction of job-search activity happens on phones — quick "is there anything new?" checks during commutes, evenings, and breaks. Many existing job aggregators treat mobile as an afterthought: the desktop layout shrinks, hover-only interactions break, tap targets are too small, and filter UIs become unusable. We will not repeat that pattern.

"Add mobile support later" almost always becomes "we'll fix it later" and never happens. Mobile-first is therefore a day-one commitment, not a Phase N polish item.

## Decision

The frontend is **mobile-first**. Base styles target a narrow viewport; desktop layouts are progressive enhancements behind a single `@media (min-width: 768px)` breakpoint. Specific commitments:

- **CSS**: [Open Props](https://open-props.style/) design tokens plus custom mobile-first CSS. No CSS framework that assumes desktop is the default.
- **Layout**: `src/styles/global.css` ships mobile defaults; the desktop block lives in one media query at the bottom of each component file.
- **`FilterTable.svelte`** has two presentations from a single component:
  - Mobile (≤ 768px): `<ul role="list">` of cards
  - Desktop (≥ 768px): `<table>` with sortable columns
  - Implementation detail: CSS Grid with `display: contents` on the row swaps presentation by media query.
- **`FilterDrawer.svelte`** is a bottom-sheet on mobile (`position: fixed; inset-block-end: 0; transform: translateY(100%)` then JS slide up) and an inline sidebar on desktop.
- **Tap targets ≥ 44×44px** enforced via `min-block-size` and `min-inline-size`; verified in Playwright e2e on iPhone 13, Pixel 7, and iPad mini viewports.
- **No hover-only states** for interactive controls. Every hover affordance has a tap-equivalent.
- **Viewport meta** uses `viewport-fit=cover` for safe-area insets on notched devices; `theme-color` matches the design token.

Quality gates:

- Lighthouse mobile preset performance ≥ 90 (alongside the desktop ≥ 95 gate).
- Playwright e2e suite runs on Desktop Chrome, Mobile Chrome (Pixel 7), Mobile Safari (iPhone 13), and Tablet (iPad mini). All four must pass.
- axe-core a11y audit runs on mobile and desktop viewports; zero WCAG 2.1 AA violations on either.
- Visual regression snapshots taken per viewport.

## Consequences

### Positive

- The product is genuinely usable on a phone from the first deploy.
- Forces simplicity: a UI that fits on a 360 px viewport carries over to desktop without bloat.
- The component model is simpler — one component, two presentations, no separate "mobile build."
- A11y benefits accrue: bigger tap targets, no hover dependencies, semantic lists on mobile.

### Neutral

- Slightly more CSS volume per component (mobile baseline + desktop block); the discipline keeps it readable.
- Open Props is small (~3 KB gzipped) but adds a learning curve for contributors used to Tailwind / Bootstrap.

### Negative

- Some design patterns common on desktop job boards (resizable columns, multi-pane layouts) are off the table on mobile and we will not introduce them.
- Visual regression snapshots take longer (per-viewport), adding ~30 seconds to the Playwright run.

## Alternatives considered

- **Desktop-first with mobile as a Phase 4+ concern** — proven to fail in practice; deferred mobile work tends to never happen.
- **Separate mobile and desktop entry points** — duplicated logic, double the maintenance, fragmented analytics.
- **Tailwind CSS** — works, but encourages utility soup that obscures the mobile-first commitment in the markup; Open Props gives us the same token discipline without the inline class explosion.
