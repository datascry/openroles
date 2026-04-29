# Spec: Visual Theme — Brutalist Press

**Version**: 1.0.3

The visual theme is a typographic system inspired by hand-set newsprint and contemporary art-magazine mastheads. It is opinionated about hierarchy, density, and accent. It is the only sanctioned look-and-feel; any rendering surface in the site MUST resolve to the tokens defined here.

## Identity

Heavier sibling of an editorial sans-serif system. Display sans for headlines (Helvetica-grade weight, all caps), serif for running body, hot red as the only accent — reserved for state changes (new, active, alert, comp). Thick rules between every section evoke hand-set typography. Looks like an art-magazine masthead or a contemporary zine.

## Palette

Two surfaces, three ink stops, one accent, two rule weights — paired in light and dark variants. The dark palette is selected by `:root[data-theme="dark"]`; the toggle in the masthead persists the user's choice in `localStorage` and the OS `prefers-color-scheme` is the first-load fallback.

### Light theme

| Token | Value | Use |
|---|---|---|
| `--color-paper` | `#f2efe9` | Page surface |
| `--color-ink` | `#0a0a0a` | Headings, primary text, hard rules |
| `--color-ink-2` | `#2a2a2a` | Body text, secondary copy |
| `--color-ink-3` | `#6e6a63` | Muted captions, labels, mono detail |
| `--color-rule` | `#0a0a0a` | Section dividers, table borders |
| `--color-rule-soft` | `#c8c2b6` | Subtle inline dividers |
| `--color-accent` | `#c8261a` | NEW state, active filter, alert, comp |
| `--color-accent-soft` | `#f6e3df` | Accent-tinted backgrounds |
| `--color-on-accent` | `#ffffff` | Text on accent surfaces |

### Dark theme

| Token | Value | Use |
|---|---|---|
| `--color-paper` | `#14110d` | Page surface (very dark warm brown) |
| `--color-ink` | `#f5f0e6` | Headings, primary text, hard rules |
| `--color-ink-2` | `#d4cdc0` | Body text, secondary copy |
| `--color-ink-3` | `#8e8a82` | Muted captions, labels, mono detail |
| `--color-rule` | `#f5f0e6` | Section dividers, table borders |
| `--color-rule-soft` | `#44403a` | Subtle inline dividers |
| `--color-accent` | `#f04d3a` | NEW state, active filter, alert, comp |
| `--color-accent-soft` | `#3a1f1a` | Accent-tinted backgrounds |
| `--color-on-accent` | `#14110d` | Text on accent surfaces |

`--color-paper` for both themes is mirrored as a literal pair in the HTML `<meta name="theme-color" media="(prefers-color-scheme: ...)">` tags because the spec for that meta tag does not accept CSS variables. Any future change to `--color-paper` (in either theme) MUST update both sites.

## Type stack

System stacks only. The site does not request any web fonts at runtime.

| Token | Stack |
|---|---|
| `--font-display` | `"Helvetica Neue", "Inter Tight", "Akzidenz-Grotesk", Helvetica, Arial, sans-serif` |
| `--font-serif` | `"Tiempos Text", "Source Serif 4", "Iowan Old Style", Georgia, serif` |
| `--font-mono` | `ui-monospace, SFMono-Regular, "JetBrains Mono", Menlo, monospace` |

### Type scale

A nine-step scale defined in `--text-N`. Values listed are the mobile defaults; the desktop column is the value applied at `min-width: 768px`.

| Token | Mobile | Desktop | Typical use |
|---|---|---|---|
| `--text-00` | 0.625rem | 0.625rem | Mono labels, kickers |
| `--text-0` | 0.6875rem | 0.6875rem | Mono detail, strap |
| `--text-1` | 0.75rem | 0.8125rem | Small body, footnote |
| `--text-2` | 0.875rem | 0.9375rem | Body |
| `--text-3` | 1rem | 1.0625rem | Emphasized body, lede sub |
| `--text-4` | 1.25rem | 1.5rem | Subheading |
| `--text-5` | 1.875rem | 2.25rem | Heading |
| `--text-6` | 2.5rem | 2.75rem | Hero heading |
| `--text-7` | 3rem | 4rem | Display |

Tokens are the only sanctioned font sizes. Component CSS MUST NOT inline `font-size: 14px` or similar.

### Tracking

| Token | Value | Use |
|---|---|---|
| `--track-tight` | `-0.02em` | Display headings |
| `--track-snug` | `-0.01em` | Sub-headings |
| `--track-normal` | `0` | Body |
| `--track-wide` | `0.06em` | Nav, button labels |
| `--track-wider` | `0.12em` | Mono section labels, kickers |

### Weights

Display sans uses 700 (semibold) and 800–900 (bold/black). Serif body stays 400. Mono stays 400. There are no italic styles.

## Spacing & rules

Spacing aliases Open Props' `--size-N` scale 1:1: `--space-1` through `--space-9`. Rules:

- `border-radius` is `0` everywhere. The brutalist signature.
- Section dividers use `--color-rule` at 1px, 2px, or 4px depending on hierarchy.
- The masthead bottom rule is the heaviest weight (4px mobile, 6px desktop).
- The page footer top rule mirrors the masthead.

## Density

- Tap-target floor: 44×44 CSS px on every interactive element. Non-negotiable.
- Body line-height: 1.45–1.55 for serif copy; 1.05–1.2 for display headings.
- Mobile padding scale: `--space-3` to `--space-5` for sections; `--space-2` to `--space-3` for inline.
- Desktop padding scale shifts up by one step.

## State discipline

Two state stops in the palette: bright accent for *positive / alert* state, muted ink-3 for *negative-but-not-error* state. Each is reserved.

### Accent (`--color-accent`)

MUST appear only on:

- The "new" indicator (postings within the freshness window — see [filter-ui.md](filter-ui.md) `since`).
- Active filter chips and active nav items.
- Compensation values (when present).
- Alerts and error states.
- The brand mark's middle dot.

Decorative accent — borders, drop shadows, logo treatments, illustrations — is REJECTED.

### Muted ink (`--color-ink-3`)

MUST appear on negative-but-not-error states where bright accent would be too loud:

- The `STALE · ND` badge on roles carried forward from a previous build (see [role-lifecycle.md](role-lifecycle.md)).
- Archived / deprecated indicators (none ship today; reserved for future).
- The age glyph on roles older than 30 days (currently rendered as the YYYY-MM-DD date in mono).

Stale rows additionally apply `opacity: 0.6` to the whole row container so they read as secondary at a glance, without changing any per-cell color.

Using `--color-ink-3` for primary content (running body copy, labels, button text) is REJECTED — it's a state stop, not a content stop. The text of muted-state badges sits at `--color-ink-3` only because the badge itself signals "this is not load-bearing right now."

## Accessibility floor

- Every text/background pair MUST clear WCAG 2.1 AA contrast. Reference pairs (measured by axe-core / WCAG relative-luminance):

  Light theme:
  - `--color-ink` on `--color-paper` → 19.13:1 (AAA)
  - `--color-ink-2` on `--color-paper` → 12.61:1 (AAA)
  - `--color-ink-3` on `--color-paper` → 4.59:1 (AA)
  - `--color-accent` on `--color-paper` → 4.91:1 (AA)

  Dark theme:
  - `--color-ink` on `--color-paper` → 16.79:1 (AAA)
  - `--color-ink-2` on `--color-paper` → 11.52:1 (AAA)
  - `--color-ink-3` on `--color-paper` → 5.46:1 (AA)
  - `--color-accent` on `--color-paper` → 5.20:1 (AA)
- `prefers-reduced-motion: reduce` is honored: any animation MUST gate on this query.
- Focus-visible outlines are 2px solid `--color-accent` with 2px offset on all keyboard-tabbable elements.
- Tap targets ≥ 44×44 CSS px.
- `aria-current="page"` on active nav items.

## Rejection cases

The following are non-negotiable rejection reasons in code review:

- Raw hex literals in component CSS. Every color reference MUST resolve to a token. The single exception is the `<meta name="theme-color">` literal (annotated in `BaseLayout.astro`).
- Non-token font sizes (`font-size: 18px`, `font-size: 1.2rem`, etc.). Use `--text-N`.
- Non-token spacing literals (`padding: 12px`, `margin: 1.5rem`). Use `--space-N`.
- Accent used as decoration, gradient, or border on non-state surfaces.
- Web font requests at runtime. System stacks only.
- `border-radius` other than `0` on any rectangular surface.
- Missing `prefers-reduced-motion` gate on any `@keyframes` or `transition`.

## Files

- `site/src/styles/tokens.css` — token definitions; imported once by `BaseLayout`.
- `site/src/styles/global.css` — resets, base typography, button primitives, focus-visible, prefers-reduced-motion.
- `site/src/layouts/BaseLayout.astro` — html shell, theme-color literal, slot.
- `site/src/components/Masthead.astro` — page chrome.

## Canonical example

```html
<!-- A section heading + body paragraph, brutalist press. -->
<section>
  <p class="kicker">Browse · Phase 9</p>
  <h2>The filter island lands next.</h2>
  <p>Body copy is set in <var>--font-serif</var>, sized at <var>--text-2</var>.</p>
</section>
```

```css
.kicker {
  color: var(--color-ink-2);
  font-family: var(--font-display);
  font-size: var(--text-00);
  font-weight: 700;
  letter-spacing: var(--track-wider);
  text-transform: uppercase;
}
h2 {
  color: var(--color-ink);
  font-family: var(--font-display);
  font-size: var(--text-5);
  font-weight: 800;
  letter-spacing: var(--track-tight);
  line-height: 1;
  text-transform: uppercase;
}
```
