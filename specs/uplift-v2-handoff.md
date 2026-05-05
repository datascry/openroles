# Spec: Uplift v2 — Developer handoff

**Version**: 0.1.0 (draft)
**Status**: Design approved, awaiting implementation phase
**Companion**: `design-wireframes/v2-uplift/` (interactive HTML reference)

This spec is the developer handoff for three approved uplift surfaces: **dual-mode tabbed search**, **persistent sidebar filter (with mobile sheet fallback)**, and the **editorial broadsheet role-detail page**. It is the implementation contract — anything ambiguous here will be guessed by the implementer, so be explicit.

All measurements resolve to tokens in `site/src/styles/tokens.css` (sourced from `specs/visual-theme.md` v1.0.3). Do not introduce new colour, typography, spacing, or rule-weight primitives. If a surface needs something the system can't express, raise it in a new ADR rather than hard-code.

The site is **Astro 6 + Svelte 5 islands** on **Bun 1.3**. State for filters lives in `FilterState` (`site/src/lib/filter-state.ts`); state for personal lists lives in `localStorage` via `site/src/lib/storage.ts`. SQLite queries flow through `loadClientDb` (`site/src/lib/client-db.ts`). Do not spin up new state stores; extend the existing ones.

---

## 0. Cross-cutting design tokens

The three surfaces draw from the same token surface. Tokens are listed once here and referenced by name below.

### Colour

| Token | Light | Dark | Usage in this spec |
|---|---|---|---|
| `--color-paper` | `#f2efe9` | `#14110d` | Page surface, sidebar background, panel background |
| `--color-ink` | `#0a0a0a` | `#f5f0e6` | Primary text, hard rules, active chip fills |
| `--color-ink-2` | `#2a2a2a` | `#d4cdc0` | Body copy, secondary captions |
| `--color-ink-3` | `#6e6a63` | `#8e8a82` | Muted labels, dashed-rule colour |
| `--color-rule` | `#0a0a0a` | `#f5f0e6` | Section dividers (≥ 2 px) |
| `--color-rule-soft` | `#c8c2b6` | `#44403a` | Inline 1 px dividers, dashed group separators |
| `--color-accent` | `#c8261a` | `#f04d3a` | Apply CTA, active counts, "NEW" badge, focus outline |
| `--color-accent-soft` | `#f6e3df` | `#3a1f1a` | Stale banner, accent-tinted backgrounds |
| `--color-on-accent` | `#ffffff` | `#14110d` | Text on accent fills |

### Typography

| Token | Family | Default size (mobile / ≥ 768 px) |
|---|---|---|
| `--font-display` | `Helvetica Neue, Inter Tight, …` | — |
| `--font-serif` | `Tiempos Text, Source Serif 4, …` | — |
| `--font-mono` | `ui-monospace, SFMono-Regular, …` | — |
| `--text-00` | — | 10 / 10 px |
| `--text-0` | — | 11 / 11 px |
| `--text-1` | — | 12 / 13 px |
| `--text-2` | — | 14 / 15 px |
| `--text-3` | — | 16 / 17 px |
| `--text-4` | — | 20 / 24 px |
| `--text-5` | — | 30 / 36 px |
| `--text-6` | — | 40 / 44 px |
| `--text-7` | — | 48 / 64 px |

Tracking: `--track-tight` (-0.02 em) for display headlines, `--track-wide` (0.06 em) for nav/buttons, `--track-wider` (0.12 em) for mono captions.

### Spacing, rules, tap

| Token | Value | Usage |
|---|---|---|
| `--space-1` | 0.25 rem | Inline gaps, badge padding |
| `--space-2` | 0.5 rem | Tight stacking |
| `--space-3` | 1 rem | Default vertical rhythm |
| `--space-4` | 1.25 rem | Section padding |
| `--space-5` | 1.5 rem | Block spacing |
| `--space-6` | 1.75 rem | Page-level spacing |
| `--space-7` | 2 rem | Major section breaks |
| `--space-8` | 3 rem | Header/footer padding |
| `--space-9` | 4 rem | Page bottom padding |
| `--rule-1` | 1 px | Inline dividers, default chip border |
| `--rule-2` | 2 px | Section borders, active filters |
| `--rule-4` | 4 px | Page-level rules |
| `--rule-6` | 6 px | Masthead bottom rule (≥ 768 px) |
| `--tap` | 44 px | Minimum touch target — every interactive element |

### Breakpoints

The system has two breakpoints today (`768 px`, `960 px`). The uplift introduces no new breakpoints.

| Breakpoint | Range | Layout posture |
|---|---|---|
| Mobile | `< 768 px` | Single column, sheet drawers, type scale base |
| Tablet | `768–959 px` | Bumped type scale, two-column where applicable |
| Desktop | `≥ 960 px` | Sidebar-aware layouts, table-style result row |

### Motion

The system honours `prefers-reduced-motion: reduce` globally — animation duration is forced to `0.01 ms` and transitions to `0.01 ms`. Specs below cite duration/easing for users who have **not** opted out; the reduced-motion path is to skip all of it and switch state immediately.

| Token | Value | Usage |
|---|---|---|
| (literal) | `120 ms` `ease-out` | Hover state changes (background, border) |
| (literal) | `180 ms` `cubic-bezier(.25,0,.4,1)` | Popover/sheet enter |
| (literal) | `120 ms` `ease-in` | Popover/sheet exit |

Use Open Props' `--ease-2: cubic-bezier(.25,0,.4,1)` where the value is referenced in CSS. Do not introduce spring or elastic easings.

---

## 1. Surface — Dual-mode tabbed search

**Wireframe**: `design-wireframes/v2-uplift/01-search-bar-alternatives.html` § Alt 2

### 1.1 Overview

A two-tab control above the search surface. The default tab is **Free text** and behaves identically to today's search input: a single field that accepts a DSL (`title:`, `company:`, `description:`, `location:`, plus quoted phrases). The second tab is **Structured** and exposes three labelled inputs (Title, Company, Location) plus an explicit Search button, and a row of saved searches below.

Both tabs write to and read from the same `FilterState.q` string. Switching tabs MUST preserve the query: the structured form parses an existing `q` into its named fields on tab activation; the free-text form recomposes the structured fields into a `q` string on tab switch.

**Why**: today's DSL is hidden in the placeholder. The structured tab makes filtering discoverable for first-time visitors without removing the keyboard speed of the free-text path. Saved searches are the closest the no-account product gets to "alerts".

### 1.2 Layout

Sits inside `<section class="lede">` immediately below the masthead (replaces the current `h2` lede + supporting paragraph — see audit recommendation #5).

```
┌──────────────────────────────────────────────────────────┐
│  [ FREE TEXT ]  [ STRUCTURED ]                           │   <- a2-tabs
├──────────────────────────────────────────────────────────┤
│  ┌─────────────────────────────────────────────────────┐ │
│  │  free-text mode: single input                       │ │   <- a2-mode
│  │                                                     │ │
│  │  structured mode: 3 input grid + Search button      │ │
│  └─────────────────────────────────────────────────────┘ │
├──────────────────────────────────────────────────────────┤
│  RECENT  ·  [pill] [pill] [pill]   [+ Save current]      │   <- a2-recent
└──────────────────────────────────────────────────────────┘
```

### 1.3 Tokens

| Element | Token references |
|---|---|
| Tabs container border-bottom | `var(--rule-2) solid var(--color-ink)` |
| Tab inactive | `var(--font-display)`, `var(--text-1)`, weight 700, `--color-ink-3`, transparent border-bottom |
| Tab active | as above + `--color-ink` text, `var(--rule-4) solid var(--color-accent)` border-bottom (overlaps the container rule) |
| Tab padding | `var(--space-3) var(--space-4)`, min-height `var(--tap)` |
| Mode container padding | `var(--space-3)` block |
| Free-text input | `var(--rule-2) solid var(--color-ink)`, square corners, `var(--text-3)` font-size, weight 600 |
| Structured grid gap | `var(--space-3)` |
| Field labels | `var(--font-mono)`, `var(--text-00)`, `var(--track-wider)`, uppercase, `--color-ink-2` |
| Search button (structured) | `--color-accent` background, `--color-on-accent` text, `var(--rule-1) solid var(--color-accent)` |
| Recent label | `var(--font-mono)`, `var(--text-00)`, uppercase, `--color-ink-3` |
| Recent pill | `var(--rule-1) solid var(--color-rule-soft)`, `var(--font-mono)`, `var(--text-1)`, padding `var(--space-1) var(--space-3)` |

### 1.4 Component contract

The component lives at `site/src/components/SearchBar.svelte` (new). It is mounted by the existing `FilterTable` parent or — preferred — promoted to `index.astro` and exchanges state with `FilterTable` via URL (the canonical store).

```ts
// SearchBar.svelte props (Svelte 5)
interface Props {
  /** Current free-text query — reads/writes FilterState.q */
  q: string;
  /** Triggered when q changes (debounced 250 ms in free-text, immediate in structured submit) */
  onChange: (next: string) => void;
  /** Saved searches — read from localStorage on mount */
  savedSearches?: ReadonlyArray<{ id: string; label: string; q: string }>;
  /** Called when the user clicks "+ Save current" */
  onSaveSearch?: (label: string, q: string) => void;
  /** Called when the user clicks a saved-search pill */
  onApplySavedSearch?: (id: string) => void;
}
```

The structured tab's three named inputs round-trip through `q` using the existing DSL — a DSL parser/composer pair lives at `site/src/lib/search-dsl.ts` (new). Contract:

```ts
// search-dsl.ts
export interface StructuredQuery {
  title: string;     // Goes to title:"…" if it contains spaces, else title:…
  company: string;   // Same convention as title
  location: string;  // Same convention as title
  freeText: string;  // Anything not bound to a prefix (joined with space)
}

export function parseQuery(q: string): StructuredQuery;
export function composeQuery(s: StructuredQuery): string;
```

`parseQuery` MUST be the inverse of `composeQuery` for any `StructuredQuery` value. Property tests (fast-check) MUST cover this round-trip — the project's TDD floor requires it.

### 1.5 States

| State | Trigger | Behaviour |
|---|---|---|
| Default (free text, empty) | Page load with `?q=` empty | Input shows placeholder `Search 56 open roles…` (count is dynamic, sourced from manifest); both tabs visible; Recent row visible if `savedSearches.length > 0`, hidden otherwise. |
| Default (free text, populated) | Page load with `?q=…` set | Input shows the raw query; tab indicator stays on Free text. |
| Default (structured, populated) | Page load when `q` parses to ≥ 1 named field and 0 free-text remainder | Tab indicator on Structured; the three inputs hold the parsed values. (See edge case 1.8.b for the mixed case.) |
| Hover (tab) | Pointer enters | Text colour transitions `--color-ink-3 → --color-ink` over 120 ms. |
| Active (tab) | Click / Space / Enter | Border-bottom colour transitions to `--color-accent` over 120 ms; mode panel switches synchronously (no fade). |
| Focus (input) | Tab focus | `outline: var(--rule-2) solid var(--color-accent)`, `outline-offset: 3px` (overrides default 2 px to clear the input's own 2 px border). |
| Typing (free text) | `input` event | 250 ms debounce, then `onChange(q)` fires and `runQuery` re-runs. Loading state from `FilterTable` continues to drive the results panel; this component does not render results. |
| Submit (structured) | Click Search / Enter from any structured input | `composeQuery` immediately, `onChange(composed)` fires (no debounce). |
| Save current | Click `+ Save current` | Inline prompt — single text input replaces the pill in place — accept on Enter, cancel on Escape. Persists to `localStorage` via `lib/storage.ts:saveSearch(label, q)`. |
| Apply saved | Click a saved pill | `onApplySavedSearch(id)` → loads the stored `q` and switches to whichever tab last edited it. |

### 1.6 Responsive behaviour

| Breakpoint | Changes |
|---|---|
| `< 720 px` | Structured grid collapses from 4 cols (title, company, location, button) to 1 col stacked. Search button becomes full width. Recent pills remain inline-wrapping. |
| `720–767 px` | Tabs and grid as desktop, but type scale stays at the mobile size from `tokens.css`. |
| `≥ 768 px` | Type scale bumps via the `tokens.css` media query; no layout change. |
| `≥ 960 px` | No structural change. |

### 1.7 Edge cases

a. **Tab switch with unsaved structured input**: switching to Free Text immediately composes whatever is in the structured fields (no confirmation). Switching back parses again. This is symmetric and lossless.

b. **Mixed query** — `q` contains both named prefixes AND free-text (e.g. `title:engineer staff at company:stripe`): on first paint, the tab indicator goes to **Free text**. Switching to Structured fills `title=engineer`, `company=stripe`, `location=""`, `freeText="staff at"`. The structured tab MUST then render a small footer reading `+ free text: "staff at"` so the user knows nothing was dropped.

c. **DSL with quote** — `title:"senior engineer"`: `parseQuery` strips the outer quotes; `composeQuery` re-adds them whenever the value contains a space.

d. **Long structured value** — title input length > field width: input scrolls horizontally; no truncation, no overflow.

e. **256-char query cap**: enforced today by `maxlength="256"` on the input. Carry this forward in both modes; in structured mode, enforce per-field (`maxlength="64"` per input) and total — `composeQuery` MUST throw if the result > 256.

f. **No saved searches**: hide the entire `.a2-recent` row. Don't render an empty `RECENT` label.

g. **Saved-search label collision**: `lib/storage.ts:saveSearch` MUST de-duplicate by exact `q`, replacing the older label. Never store two entries with the same query.

h. **Loading**: this component does not own loading. The results below it carry the loading affordance; this component remains fully interactive while the DB loads.

i. **JS disabled**: render the free-text input only (use a `<noscript>` swap or the existing `<noscript>` panel from `FilterTable`). No tab UI without JS.

### 1.8 Animation / motion

| Element | Trigger | Animation | Duration | Easing |
|---|---|---|---|---|
| Tab indicator | Tab switch | Border-bottom colour fade | 120 ms | `ease-out` |
| Input focus outline | Focus | None — appears synchronously | 0 ms | — |
| Saved-pill hover | Pointer enter | Background fill `transparent → --color-ink` | 120 ms | `ease-out` |

Do not animate the mode-panel swap. Crossfading two forms is more disorienting than a snap on this density of UI.

### 1.9 Accessibility

- Tab list MUST use `role="tablist"`. Each tab is a `<button role="tab" aria-selected="…" aria-controls="…">`. The mode container is `role="tabpanel"` with `aria-labelledby` referencing its tab. (WAI-ARIA Authoring Practices Tabs pattern.)
- Keyboard: `→` / `←` move focus between tabs; `Space` / `Enter` activate the focused tab; `Tab` moves focus into the active panel.
- Free-text input MUST keep its `aria-label="Search roles"` (already present). Placeholder is decorative, not the label.
- Structured inputs use real `<label>` elements with `for=`. The label is the visible mono-caps text.
- Saved-pill row is a `<ul role="list">`. Each pill is a `<button>` with `aria-label="Apply saved search: {label}"`. The "+ Save current" trigger is `aria-disabled="true"` whenever `q` is empty.
- Result count update (live) is announced by the existing `aria-live="polite"` results-status; this component does not need its own announcer.
- Focus order: Free-text tab → Structured tab → (active mode's first input) → … → (recent pills) → (save trigger). Match this order in DOM.

---

## 2. Surface — Persistent sidebar filter (desktop) + sheet (mobile)

**Wireframe**: `design-wireframes/v2-uplift/02-filter-strip-alternatives.html` § Alt 1

### 2.1 Overview

Replaces the current dashed-`+` chip strip with a 280 px persistent sidebar on desktop and a one-button-plus-bottom-sheet on mobile. The sidebar holds every filter group (ATS, Level, Workplace, Posted, Min comp, Status toggles, Personal toggles), each with an active count, optional inline group-search for long lists, and explicit "Show all N" progressive disclosure.

State continues to flow through `FilterState` (no new fields). The sidebar reads/writes the same shape; nothing about query encoding changes. `lib/filter-url.ts:encodeFilterState` / `decodeFilterState` are unchanged.

**Why**: 54 enumerable values across 12 controls cannot fit in one wrapping row at any reasonable density. A sidebar lets every group breathe, surfaces active state at a glance, and gives long lists (24 ATS) a search affordance.

### 2.2 Layout

```
≥ 800 px (desktop)
┌──────────────┬────────────────────────────────────────────┐
│ FILTERS  3 ACTIVE                                          │
│              │                                              │
│ ATS  2/24    │   [SearchBar surface 1]                      │
│ [chips]      │   ─────────────────────────────             │
│              │   14 RESULTS · sorted newest first           │
│ Level 1/10   │                                              │
│ [chips]      │   [job result row]                           │
│              │   [job result row]                           │
│ Workplace    │   …                                          │
│ [chips]      │                                              │
│              │   [pager]                                    │
│ Posted       │                                              │
│ [chips]      │                                              │
│              │                                              │
│ Min comp     │                                              │
│ [stepper]    │                                              │
│              │                                              │
│ Status       │                                              │
│ [toggles]    │                                              │
│              │                                              │
│ Personal     │                                              │
│ [toggles]    │                                              │
│              │                                              │
│ Reset all    │                                              │
└──────────────┴────────────────────────────────────────────┘
   280 px       1fr (max-width 78 rem on the parent <main>)
```

```
< 800 px (mobile / tablet)
┌────────────────────────────────────────────────┐
│ [FILTERS · 3]   [Newest ▾]            56 ROLES │
├────────────────────────────────────────────────┤
│ [SearchBar]                                    │
│ [results]                                      │
└────────────────────────────────────────────────┘

Tap [FILTERS · 3] →

┌────────────────────────────────────────────────┐
│  Filters                          [Close]      │   <- a1-mob-bar
├────────────────────────────────────────────────┤
│  scrollable body — same group structure as     │
│  the sidebar, full width                       │
│  ATS 2/24 [chips] [+ 20 more]                  │
│  Level 1/10 [chips]                            │
│  …                                             │
├────────────────────────────────────────────────┤
│  [Reset]              [Show 14 roles]          │   <- a1-mob-foot, sticky
└────────────────────────────────────────────────┘
```

### 2.3 Tokens

| Element | Token references |
|---|---|
| Sidebar container | `var(--rule-2) solid var(--color-ink)`, padding `var(--space-3)`, gap `var(--space-3)` |
| Group `<h3>` | `var(--font-display)`, `var(--text-1)`, `var(--track-wider)`, uppercase, padding-bottom `var(--space-1)`, border-bottom `var(--rule-2) solid var(--color-ink)` |
| Group active count | inline span, `var(--font-mono)`, `var(--text-0)`, `--color-accent` |
| Inline group-search | `var(--rule-1) solid var(--color-rule-soft)`, `var(--font-mono)`, `var(--text-1)`, min-height 32 px |
| Chip (inactive) | `var(--rule-1) solid var(--color-rule-soft)`, `var(--font-mono)`, `var(--text-1)`, padding `4px var(--space-2)`, min-height 28 px |
| Chip (active) | `var(--color-ink)` background, `--color-paper` text, accent × icon |
| "Show all 24" | transparent background, no border, `var(--font-mono)`, `var(--text-0)`, `--color-accent` |
| Stepper | `var(--rule-1) solid var(--color-rule-soft)`, height 32 px, `var(--font-mono)` `var(--text-1)` |
| Toggle switch | 36 × 20 px, `var(--rule-1) solid var(--color-ink)`; thumb 14 × 14 px, `--color-ink-3` (off) / `--color-accent` (on) |
| Reset button | transparent background, no border, `--color-accent`, `var(--font-display)`, `var(--text-1)`, weight 700 |
| Mobile sheet header | `var(--rule-2) solid var(--color-ink)` bottom; padding `var(--space-3)`; h4 `var(--text-3)` weight 800 |
| Mobile sheet footer | sticky to viewport bottom; grid `1fr 1.4fr`; "Show N roles" button `--color-accent` background |

### 2.4 Component contract

Refactor `FilterTable.svelte` to extract:

- `FilterSidebar.svelte` — desktop sidebar shell + groups, props `{ state: FilterState; onPatch: (p: Partial<FilterState>) => void; resultCount: number; }`
- `FilterSheet.svelte` — mobile bottom sheet, same props plus `{ open: boolean; onClose: () => void; }`
- Group children (one per dimension): `AtsGroup`, `LevelGroup`, `WorkplaceGroup`, `PostedGroup`, `MinCompGroup`, `StatusToggles`, `PersonalToggles`. Each receives the slice of state it cares about and emits patches to `onPatch`. This is the existing pattern; just decompose it.

The orchestrator (`FilterTable.svelte`) decides which to render based on viewport (`window.matchMedia("(min-width: 800px)")` evaluated on mount and on resize).

### 2.5 States

| Element | State | Behaviour |
|---|---|---|
| Group header | Default | Active count hidden when 0; visible in `--color-accent` when ≥ 1. |
| Group header | Expanded vs collapsed | Each `<h3>` has a `<button>` toggle (mobile only — desktop never collapses). Persists per-group expansion in `localStorage` under key `openroles:filter-group:{id}`. |
| Chip | Inactive | `--color-rule-soft` border; on hover, border transitions to `--color-ink` (120 ms). |
| Chip | Active | `--color-ink` fill, `--color-paper` text, `--color-accent` × glyph. Click toggles off. |
| Chip | Disabled | `opacity: 0.4`, `cursor: not-allowed` — used when a chip would yield zero results given other active filters. (Hover surfaces a `<title>` tooltip: "0 roles match this combination.") |
| Group-search | Default | Renders only when a group has > 8 options (ATS yes, Level no). Filters chip visibility client-side as the user types. |
| Show all toggle | Default | Renders the first 6 chips; clicking expands to the full list. State is per-session (no localStorage). |
| Stepper | Default | Numeric input, 130000 default once typed; commits on blur or `Enter`. Currency token `USD` next to the input. |
| Toggle | Default → on | Thumb slides 16 px left-to-right over 120 ms ease-out; thumb fill transitions `--color-ink-3 → --color-accent` simultaneously. (Skipped under reduced motion.) |
| Reset all | Default | Button sets state to `DEFAULT_FILTER_STATE`. Confirms inline (`Reset?` with `Yes` / `Cancel`) only when ≥ 3 filters are active. |
| Mobile button (`FILTERS · n`) | Default | `n` is `activeFilterCount` from the existing derived in `FilterTable.svelte`. When 0, button reads `FILTERS`; when ≥ 1, `FILTERS · n` with `n` in `--color-accent`. |
| Mobile sheet | Closed → open | Slides up from bottom over 180 ms `cubic-bezier(.25,0,.4,1)`; overlay fades to `rgba(10,10,10,0.4)` simultaneously. |
| Mobile sheet | Open → closed | Slides down over 120 ms `ease-in`; overlay fades. |
| Mobile sheet apply button | Loading | While `runQuery` is pending after a patch, button text reads `Updating…` and the button is `aria-disabled="true"`. |

### 2.6 Responsive behaviour

| Breakpoint | Changes |
|---|---|
| `< 800 px` | Sidebar hidden; results take full width. `FILTERS · n` button appears in the bar above results. Sheet renders as a modal dialog rooted at `document.body` (portaled) when open. |
| `≥ 800 px` | Sidebar always visible at `width: 280 px`. Results shift right; max-width on `<main>` stays 78 rem so on very wide viewports there is symmetric whitespace either side. |
| `≥ 1280 px` | Sidebar grows to `320 px`; this is the only width ramp-up. No further changes. |

The breakpoint disagreement with the rest of the system (`768 px` for type, `800 px` for sidebar) is deliberate: the sidebar needs more room than the type-scale bump warrants. It is the only `800 px` breakpoint introduced — call this out in `tokens.css` as `--bp-sidebar: 800px` so future layouts can reference it.

### 2.7 Edge cases

a. **Zero results across the full corpus**: empty group states render as "No ATS in current results" (`--color-ink-3`, `var(--font-mono)`, `var(--text-0)`).

b. **Group with one option** (e.g. Workplace when filtered to remote-only): all three chips still render — disabled chips use the disabled state (2.5). This preserves the user's mental model of the dimension's full surface.

c. **Inline group-search no match**: render `No match` italic in `--color-ink-3` below the search input.

d. **Min comp = 0**: treated as undefined (clear filter). Negative values: blocked by `min="0"` on the input.

e. **Min comp very large** (e.g. 9,999,999): no truncation; format with `Intl.NumberFormat`. The stepper increment is 5,000.

f. **Personal toggles with empty list** (e.g. "Saved (0)"): toggle is disabled with `aria-disabled="true"`. Tooltip: `Save a role first.`

g. **Reset confirmation**: only appears when `activeFilterCount ≥ 3`, to avoid being annoying for trivial undos.

h. **URL state with unknown values**: `decodeFilterState` already drops unknown values silently (today's behaviour). Carry forward.

i. **Sheet open during back-button navigation**: closing the sheet must use `history.back()` if it was opened with `history.pushState`; otherwise close in place. Implementation: push a state entry on open, pop on close, listen for `popstate`.

j. **Sheet open with on-screen keyboard** (mobile): inputs inside the sheet must scroll into view (`scrollIntoView({ block: "center" })`) on focus. Use `viewport-fit=cover` (already set in `BaseLayout.astro`) and `padding-bottom: env(safe-area-inset-bottom)` on the sheet footer.

### 2.8 Animation / motion

| Element | Trigger | Animation | Duration | Easing |
|---|---|---|---|---|
| Sheet (open) | Trigger | `translateY(100%) → 0`, overlay fade-in | 180 ms | `cubic-bezier(.25,0,.4,1)` |
| Sheet (close) | Close trigger | `translateY(0) → 100%`, overlay fade-out | 120 ms | `ease-in` |
| Toggle thumb | Click | Thumb position + colour | 120 ms | `ease-out` |
| Chip border | Pointer hover | Border colour | 120 ms | `ease-out` |
| Group-search filter | Typing | None — DOM filter is synchronous | 0 ms | — |

### 2.9 Accessibility

- Sidebar is `<aside aria-label="Filters">`. Sheet is `<dialog>` (or a `role="dialog"` div with `aria-modal="true"`); on open, focus moves to the close button; on close, focus returns to the trigger.
- Each group `<h3>` is the accessible name of its `role="group"`. The active count is an `aria-live="polite"` span so screen readers hear "ATS, 2 of 24" when chips toggle.
- Chips are `<button aria-pressed="…">`. Toggle switches use `<button role="switch" aria-checked="…">`.
- Group-search input has a programmatic label (`<label class="visually-hidden">Filter ATS list</label>`).
- Keyboard inside the sheet:
  - `Tab` cycles within the sheet (focus trap).
  - `Esc` closes the sheet.
  - `Enter` on the apply button submits.
- Reset button surface a confirmation as a `role="alertdialog"` when triggered (item 2.7.g) — the Yes button receives focus.
- The mobile `FILTERS · n` button reads as `Filters, 3 active` to screen readers (use `aria-label` to compose the count, not just the visible text).
- Each chip's `aria-label` MUST include the count where shown — e.g. `aria-label="Senior, 22 roles"` — so screen-reader users get the same predictive count sighted users get.
- The apply button text doubles as state preview (`Show 14 roles`); update it whenever `resultCount` changes. Wrap that count in `aria-live="polite"` so it's announced.

---

## 3. Surface — Editorial broadsheet role detail

**Wireframe**: `design-wireframes/v2-uplift/03-role-detail-alternatives.html` § Alt 1

### 3.1 Overview

Replaces the current `RoleDetail.svelte` layout. The role posting is set as a feature article: kicker (company name), display headline (role title), serif strap (role tagline / first sentence of description), byline rule (level · workplace · department · comp · source), then a two-column body — narrative on the left with a dropcap and a comp pullquote, fact card + apply CTA + "More from $company" pinned to the right rail at desktop sizes.

**Critical preliminary**: today's `RoleDetail.svelte` references `--color-muted`, `--color-surface-2`, `--color-border`, `--font-size-3`, none of which exist in the current `tokens.css`. The page is silently rendering with browser defaults. This MUST be fixed in the same PR as the layout swap; do not ship the layout against the broken token graph.

**Why**: the role page is the conversion surface. Today it's an unstyled column; it should be the most "openroles" page on the site. The editorial treatment puts the comp band — the single most-clicked spec on any posting — in a pullquote, and uses the fact card to surface every `Role` field including ones currently hidden ("first seen", "last seen", department).

### 3.2 Layout

```
≥ 800 px (desktop)
┌─────────────────────────────────────────────────────────────────┐
│  ← All roles                              POSTED 28 APR · FRESH │   .e1-rail-top
├─────────────────────────────────────────────────────────────────┤
│  STRIPE                                                          │   .e1-co
│                                                                  │
│  SENIOR SOFTWARE ENGINEER,                                       │   .e1-headline
│  PAYMENTS RELIABILITY                                            │
│                                                                  │
│  Own the integrity of money movement at internet scale.…         │   .e1-strap
├─────────────────────────────────────────────────────────────────┤
│  SENIOR · REMOTE (US, EU) · ENGINEERING · $220K–$290K · GH       │   .e1-byline
├──────────────────────────────────────────────┬──────────────────┤
│  S tripe is hiring senior backend engineers… │  ┌──────────────┐│
│  to improve the resilience…                  │  │ APPLY ON GH  ││   apply CTA
│                                              │  │  [Open →]    ││   pinned (sticky)
│  ────────────────────────────────────────    │  │ ★ ✓ ⊘        ││
│  "$220K – $290K + EQUITY"                    │  └──────────────┘│
│  — Posted band · USD · United States         │  ┌──────────────┐│
│  ────────────────────────────────────────    │  │ THE FACTS    ││   fact card
│                                              │  │  Company …   ││
│  You'd be a strong match if…                 │  │  Title …     ││
│                                              │  │  Level …     ││
│                                              │  │  Workplace … ││
│                                              │  │  Comp min …  ││
│                                              │  │  Comp max …  ││
│                                              │  │  Posted …    ││
│                                              │  │  First seen …││
│                                              │  │  ATS …       ││
│                                              │  │  Department …││
│                                              │  └──────────────┘│
│                                              │  ┌──────────────┐│
│                                              │  │ MORE FROM    ││   related card
│                                              │  │  Stripe (14) ││
│                                              │  └──────────────┘│
└──────────────────────────────────────────────┴──────────────────┘
            1fr                                   280 px
```

```
< 800 px (mobile)
- Single column, same vertical sequence: rail-top, kicker, headline,
  strap, byline, body. Apply card moves between strap and body. Fact
  card and "more from" follow body. The byline rule wraps as needed.
- Apply CTA docks to the bottom of the viewport when the user scrolls
  past the in-flow card (sticky bottom-bar pattern).
```

### 3.3 Tokens

| Element | Token references |
|---|---|
| Page max-width | 78 rem (matches the index `<main>` cap) |
| Page padding | `var(--space-6) var(--space-4) var(--space-9)` mobile; `var(--space-7) var(--space-7) var(--space-9)` ≥ 768 px |
| Rail-top border | `var(--rule-1) solid var(--color-rule)` bottom |
| Rail-top type | `var(--font-mono)`, `var(--text-0)`, `var(--track-wider)`, uppercase, `--color-ink-3`; "FRESH"/"STALE" tag in `--color-accent` |
| Kicker (company) | `var(--font-mono)`, `var(--text-1)`, `var(--track-wider)`, weight 700, `--color-accent`, uppercase |
| Headline | `var(--font-display)`, weight 900, `var(--text-7)` (48 px mobile / 64 px ≥ 768 px), `var(--track-tight)`, line-height 0.92, uppercase |
| Strap | `var(--font-serif)`, italic, `var(--text-4)`, `--color-ink-2`, max 60 ch |
| Byline | `var(--rule-2) solid var(--color-ink)` top + bottom; padding `var(--space-2)` block; `var(--font-mono)`, `var(--text-0)`, uppercase, `--track-wider`; `<b>` items in `--color-ink` |
| Body | `var(--font-serif)`, `var(--text-3)`, line-height 1.65, `--color-ink-2` |
| Dropcap | first letter only on first body paragraph; `var(--font-display)`, weight 900, `4rem`, line-height 0.85, float: left, padding-inline-end `var(--space-2)`, color `--color-accent` |
| Pullquote | top + bottom `var(--rule-2) solid var(--color-ink)`; padding `var(--space-3)` block; `var(--font-display)` weight 800, `var(--text-5)`, `var(--track-tight)`, line-height 1.05, uppercase; "+ EQUITY" segment in `--color-accent`; sub-line `var(--font-mono)`, `var(--text-0)`, `--color-ink-3` |
| Fact card border | `var(--rule-2) solid var(--color-ink)` |
| Fact card `<h3>` | `var(--font-display)`, `var(--text-1)`, `var(--track-wider)`, uppercase; bottom rule `var(--rule-1) solid var(--color-ink)` |
| Fact row | grid `90px 1fr`, padding-block 6 px, dashed bottom `var(--rule-1) dashed var(--color-rule-soft)` |
| Fact `dt` | `var(--font-mono)`, `var(--text-1)`, uppercase, `--color-ink-3` |
| Fact `dd` | `var(--font-mono)`, `var(--text-1)`, weight 600, `--color-ink`, uppercase; `dd.accent` for level → `--color-accent` |
| Apply CTA | min-height 64 px; `--color-accent` fill, `--color-on-accent` text; `var(--font-display)`, `var(--text-3)`, weight 800, `var(--track-wide)`, uppercase; arrow glyph `→` after text |
| Secondary actions row | three buttons at flex `1 1 0`; `var(--rule-1) solid var(--color-ink)`; `var(--font-display)`, `var(--text-0)`, weight 700 |
| Stale banner | `--color-accent-soft` background, `var(--rule-4) solid var(--color-accent)` left; padding `var(--space-2) var(--space-3)`; `var(--font-serif)` italic, `var(--text-2)`, `--color-ink-2` |

### 3.4 Component contract

`RoleDetail.svelte` is rewritten in place. Props unchanged (`{ basePath: string }`). The component continues to load the `Role` row via `loadClientDb` + `buildRoleByShortIdQuery`.

The rewrite:
- Drops every reference to `--color-muted`, `--color-surface-2`, `--color-border`, `--font-size-3`, and the alt size/font-size tokens that don't exist.
- Does not introduce new state. `saved`, `applied`, `ignored` continue to come from `lib/storage.ts`.
- Adds two derived helpers (in `lib/role-detail-format.ts`, new):
  ```ts
  /** Composes the byline string parts. Handles missing fields gracefully. */
  export function bylineParts(role: Role): ReadonlyArray<{ label?: string; value: string }>;
  /** Returns the pullquote payload, or null if no comp data and no benefit fallback. */
  export function pullquote(role: Role): { quote: string; sub: string } | null;
  ```

The "More from $company" card queries `role.tenant_slug` via a new `lib/role-related-sql.ts:buildRelatedRolesQuery(tenant_slug, excludeId, limit=4)`. This is a second DB query fired in parallel with the role load.

### 3.5 States

| Element | State | Behaviour |
|---|---|---|
| Page | Loading | Existing `Loading role…` placeholder is replaced by a deterministic skeleton: grey rectangles for kicker, headline (3 lines), strap, byline, body (8 lines), and a fact card outline. Skeleton uses `--color-rule-soft` fills with no animation (matches the no-shadow editorial tone). |
| Page | Error | Existing `loadError` block kept, restyled to use the editorial frame (rule-2 border, mono caption, accent "BACK" link). |
| Page | Stale role | Add `.e1-stale` banner above the body section: italic serif copy reading "This role was last seen in our database on {last_seen_at_human}. Stripe may have removed the original posting." |
| Page | Recruiter post | Insert kicker line below the byline: "POSTED BY AN EXTERNAL RECRUITER" in `--color-ink-3` mono. Don't downgrade the apply CTA. |
| Apply CTA | Default | Anchor styled as button. `target="_blank"`, `rel="noopener noreferrer"`. Text reads `Apply on {ATS_PRETTY[ats]}`. |
| Apply CTA | Hover | Background transitions `--color-accent → --color-ink` over 120 ms; text colour `--color-on-accent → --color-paper`. |
| Apply CTA | Sticky (mobile, scrolled past in-flow) | Bottom-fixed bar with the apply CTA only; height 56 px; `position: fixed; bottom: 0; left: 0; right: 0; z-index: 50;`. Includes safe-area inset bottom padding. Hidden on desktop. |
| Save / Applied / Ignore | Default | Outlined buttons; `aria-pressed` toggles. On press, button fills with `--color-ink` and text reads "★ Saved" / "✓ Applied" / "⊘ Ignored". |
| Pullquote | No comp data, no fallback benefit | Omit the pullquote element entirely (do not render an empty rule). The body collapses to a single column without the bordered block. |
| Pullquote | Has comp band | "$X – $Y + equity" if equity is mentioned in the description excerpt, else just the band. The "+ equity" tail is split into a `<span class="accent">` so it picks up `--color-accent`. |
| Pullquote | One side of band only | "From $X" or "Up to $Y" — same `formatComp` shape as today, set in display weight. |
| Fact card | Missing field | Render the row with `dd` set to `<em class="muted">not stated</em>`. Never silently drop a row — the card communicates the schema. |
| "More from" card | 0 other roles | Hide the entire card. |
| "More from" card | ≥ 1 other roles | Show up to 4; below them, "All N {Company} roles →" links to the tenant page. |
| Rail-top "FRESH" tag | `posted_at` within 7 d | `--color-accent`, "FRESH" |
| Rail-top "FRESH" tag | `posted_at` within 30 d | `--color-ink`, "ACTIVE" |
| Rail-top "FRESH" tag | `posted_at` older or null | `--color-ink-3`, "{N} DAYS AGO" or "FIRST SEEN {date}" |

### 3.6 Responsive behaviour

| Breakpoint | Changes |
|---|---|
| `< 800 px` | Single column. Order: rail-top, kicker, headline, strap, byline, **apply CTA card**, body (with dropcap and pullquote), fact card, "more from" card. Apply card sticky-bar appears once the user has scrolled past the in-flow card. |
| `≥ 800 px` | Two-column grid `1fr 280px`, gap `var(--space-7)`. Right rail is `position: sticky; top: var(--space-3);` so apply + facts stay in view. |
| Headline | Mobile 48 px → ≥ 768 px 64 px (per `tokens.css` `--text-7` ramp). |

### 3.7 Edge cases

a. **Headline > 4 lines** (very long titles): no truncation; let the headline grow. Keep `line-height: 0.92` so it looks intentional.

b. **No description excerpt**: replace the body with a single paragraph reading "No description available from the source ATS. Open the apply link to read the full posting on {ATS_PRETTY[ats]}.", set in `--font-serif`, italic, `--color-ink-3`. The dropcap is omitted.

c. **Description excerpt with HTML**: the schema strips HTML at scrape time per `specs/data-schema.md`; if anything sneaks through, escape on render. Never `innerHTML`.

d. **International strap**: longer Romance-language strapline can blow past 60 ch — leave it unwrapped, the serif handles long lines well.

e. **Stale + recruiter + no comp**: all three states stack. The page shows: stale banner, recruiter line, no pullquote, fact card with "Comp min / Comp max" both `not stated`.

f. **Role 404** (`loadError !== null`): error block sits inside the same editorial frame. Title "ROLE NOT FOUND", strap "{loadError}", a single link back to `/`. No fact card, no apply CTA.

g. **`posted_at === null`, `first_seen_at` set**: rail-top shows "FIRST SEEN {date}" instead of "POSTED {date}".

h. **`compensation_currency === null` but min/max set**: render the band without the currency suffix (today's behaviour).

i. **Document title change**: continue to `document.title = "{role.title} at {role.company} · openroles"` in `onMount` after role load — required for share-link unfurls.

j. **Print stylesheet**: hide `.e1-cta` (apply card), `.e1-rail-top`, and the "more from" card; render the fact card inline above the body. Print-friendly.

### 3.8 Animation / motion

| Element | Trigger | Animation | Duration | Easing |
|---|---|---|---|---|
| Page (load done) | `loading: true → false` | Skeleton fades out, content fades in (cross-fade) | 180 ms | `ease-out` |
| Apply CTA hover | Pointer enter | Background colour | 120 ms | `ease-out` |
| Sticky apply (mobile) | User scrolls past in-flow card | Slide-in from bottom | 180 ms | `cubic-bezier(.25,0,.4,1)` |
| Sticky apply (mobile) | User scrolls back above | Slide-out to bottom | 120 ms | `ease-in` |
| Save/Applied/Ignored | Click | `aria-pressed` flip; fill colour transition | 120 ms | `ease-out` |

All paths skip under `prefers-reduced-motion`.

### 3.9 Accessibility

- Document outline: `<h1>` is the role title (single h1 per page). Every section uses `<section>` with `<h2>` (Description; "More from {company}" → `<h2>` set visually as `<h3>`-style). Fact card title is `<h3>`.
- Headline MUST not be split with `<br>` for visual line breaks; rely on natural wrap. Screen readers should hear the title as a single string.
- The kicker (company name) is announced as the company link's accessible name via `aria-labelledby`.
- Byline list: `<ul role="list">` with each `<li>` containing a `<strong>` for the value. The opening rule and closing rule are decorative (`aria-hidden="true"`).
- Pullquote: `<blockquote>` with `<cite>` for the sub-line. Quotation marks are part of content.
- Fact card: `<dl>` with `<div>` row wrappers (each row is one `<dt>` + `<dd>`). The card's `<h3>` is the accessible name via `aria-labelledby`.
- "More from {company}" list: `<ul role="list">` of `<a>` items; each link's accessible name is "{title} at {company}" composed via `aria-label`.
- Apply CTA: `<a>` with `aria-label="Apply for {role.title} at {role.company} on {ATS_PRETTY[ats]} (opens in a new tab)"`. The visible text remains short.
- Save / Applied / Ignored buttons: `aria-pressed`; visible text already changes ("Save" → "Saved"). Focus stays on the button after press.
- Sticky mobile apply: when the in-flow CTA moves out of view, the sticky version becomes the first focusable item in tab order at the bottom of the viewport. To avoid duplicate tab stops, hide whichever is visually obscured from the accessibility tree (`aria-hidden`).
- Skeleton loading state has `role="progressbar"` `aria-busy="true"` `aria-label="Loading role"` on the article element.
- Local-state disclosure: append a `<p class="d3-disclosure">` paragraph below the description: "Saved / applied / ignored states are stored in this browser only — they do not sync across devices and we don't see them on the server." Use `--font-mono`, `--text-1`, dashed `--color-rule` border. (Addresses the prior critique's hidden-state finding.)

---

## 4. Implementation phasing

The three surfaces SHOULD ship as three independent PRs in this order. Each PR must satisfy the existing TDD floor (per-file line ≥ 95%, function ≥ 95%, branch ≥ 90%) and pass the phase-audit gate (fresh Opus 4.7 subagent review per `CLAUDE.md`).

1. **PR A — Token-rot fix on `RoleDetail.svelte`** (≤ 1 day). Strictly a refactor: replace the dead tokens with their Brutalist Press equivalents, write a snapshot test, ship. No layout change. Unblocks PR C.

2. **PR B — Sidebar filter + mobile sheet** (medium). Decompose `FilterTable.svelte` into `FilterSidebar` + `FilterSheet` + per-group children. Add the `--bp-sidebar` token. Update `specs/filter-ui.md` to v1.3.0 with the new layout contract. Property tests for the per-group active counts.

3. **PR C — Dual-mode tabbed search** (medium). Add `lib/search-dsl.ts` with parser/composer + fast-check round-trip property test. Add `SearchBar.svelte`. Wire to `FilterTable` via `q` round-trip. Update `specs/filter-ui.md` to v1.3.1.

4. **PR D — Editorial role-detail layout** (medium). Rewrite `RoleDetail.svelte` against the editorial layout. Add `lib/role-detail-format.ts` and `lib/role-related-sql.ts`. Skeleton loading state. Print stylesheet. Update `specs/role-detail.md` to v3.1 (or v4 if the change is breaking enough to justify).

PR B and C are both Phase 8 follow-ons in `docs/adr/0010-phase-plan.md`; PR D fits inside the Phase 12 lifecycle work because it touches stale-state surfacing.

---

## 5. Open decisions for review

These choices are flagged for design review before implementation locks them.

1. **Saved searches storage shape** — what gets persisted for "+ Save current"? Proposal: `{ id: string (uuid); label: string; q: string; createdAt: string (ISO) }[]`. Cap at 12 entries; LRU eviction. Confirm before committing the storage shape.
2. **Sidebar bp at 800 px vs the existing 768 px** — is the 32 px disagreement worth introducing a new token, or do we just stretch the layout to work at 768 px?
3. **Pullquote fallback** — when there's no comp data, do we fall back to a benefit (parsed from the description) or simply omit? Proposal: omit. Adding NLP for benefit extraction is out of scope.
4. **"More from {company}" query budget** — the related-roles query adds one round-trip per role-detail page load. Acceptable on sql.js-httpvfs cached connection; quantify on a cold load.
5. **Print stylesheet vs PDF export** — both have been suggested. Proposal: print-only for PR D; PDF export ships as a separate phase if we choose.

---

*Last edited 2026-05-04 — pairs with `design-wireframes/v2-uplift/` interactive reference. Supersedes the prior critique document.*
