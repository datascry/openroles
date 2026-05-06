# Spec: Filter UI

**Version**: 2.0.0

The filter UI is the primary interactive surface. It runs as a Svelte island hydrated with `client:idle` over a static Astro page. State lives in two places: the URL query string (shareable, deep-linkable) and `localStorage` (saved/applied/ignored, plus per-group expansion preferences).

## Implementation status

What ships today:

- Dual-mode tabbed search (free-text DSL + structured fields), 250 ms debounce
- Sidebar filter groups: Workplace, Posted, Level, Min comp, Status, Personal, ATS — all collapsible accordions; Workplace + Posted open by default, the rest collapsed
- Mobile filter sheet (slide-up drawer) replicates the sidebar's group structure
- ATS / Level / Workplace multi-select chips
- Posted recency window, min-compensation floor, hide-recruiter, hide-stale toggles
- Saved-searches strip with localStorage persistence
- Save / Apply / Ignore per-row buttons backed by localStorage; "Show only" filter chips for each
- URL ↔ FilterState round-trip via `history.replaceState`
- Slim-index runtime: a Web Worker fetches and decodes 38 chunked `.json.gz` files, merges them into an in-memory `SlimRow[]`, and the FilterTable runs filter / sort / search / pagination as array operations
- Pagination controls with `requestAnimationFrame`-deferred scroll-to-top on page change
- Loading / empty / busy ("LOADING ROLES…" pulse-dot) / terminal-load-error states
- `aria-live="polite"` results-status; `role="alert"` on terminal errors
- Manifest fetch + chunk-0 fetch wrapped in a 3-attempt 200 / 800 / 2000 ms backoff so a single mobile-network blip doesn't surface the harsh "COULD NOT LOAD" error

What is *not* implemented (intentionally):

- **Sort UI**: removed. Default sort is `posted_at:desc` (newest first); the dropdown's other six options were either developer concepts (first_seen) or duplicated by filter chips (level). The `sort` URL parameter still parses for back-compat with old shared links — values fall back to default if unhandled.
- **Country / region** inputs: present in `FilterState` but no UI surface.

## Runtime contract

1. Astro pre-renders the page with:
   - The masthead, hero, and filter chrome placeholders.
   - The first 50 role rows as static HTML (`FirstPaintRows.astro`) inside an `aside#first-paint-rows` wrapped in a `.first-paint-layout` grid that mirrors the hydrated `.layout-grid` so SSR rows render at the same horizontal position they will after hydration — no horizontal layout shift on the hydration boundary.
   - The same 50 rows as JSON in `<script type="application/json" id="first-paint-data">` so the Svelte island can seed its in-memory dataset without a re-fetch.
2. The Svelte island hydrates on `client:idle`, then:
   - Reads the seed rows from `#first-paint-data` and removes the SSR aside.
   - Calls `withRetry(() => fetchManifest(basePath))` — 3 attempts with 200 / 800 / 2000 ms backoff.
   - Calls `loadSlimIndex({ basePath, manifest, seed, onChunk })` which constructs a Web Worker (`slim-index-worker.js`) and requests chunk 0 over `withRetry`. The worker fetches each chunk, gunzips it, parses it, and posts the rows back as a JSON string.
   - Subsequent chunks stream sequentially (the worker is single-threaded; concurrent fetches just queue up megabytes of in-flight blobs without throughput gain). Each chunk merges into the in-memory `SlimRow[]` and triggers a throttled `runFilter` pass (1500 ms throttle, trailing edge).
3. `runFilter` is async: it sets `isQueryRunning = true`, yields to the event loop (so the "LOADING ROLES…" indicator paints) and then synchronously walks `slimIndex.rows`, sorts the matches, slices the page, and clears `isQueryRunning`. A monotonic `queryToken` discards stale results when fast successive state changes interleave with a slow filter pass.
4. Per-query failures populate `queryError` (rendered inline above results) without latching the panel. Terminal manifest / chunk-0 failures *after retry exhaustion* set `dbStatus = "error"` and render a `role="alert"` panel — that state is intentionally non-recoverable without a page reload.

## Visible behavior

### Search (v1.3.1 — dual-mode tabbed search)

The search surface is a tabbed component ([SearchBar.svelte](../site/src/components/SearchBar.svelte)) with two modes that round-trip through the same `FilterState.q` string.

**Free text tab** (default) — single input that accepts the existing DSL (`title:`, `company:`, `description:`, `location:`, plus quoted phrases). Debounced at 250 ms before `onChange(q)` fires. Behaviour is unchanged from v1.2.0.

**Structured tab** — three labelled inputs (Title, Company, Location) plus an explicit Search button. On submit, `composeQuery({ title, company, location, freeText })` produces the canonical DSL string and `onChange` fires immediately (no debounce).

The two tabs share `FilterState.q`. Switching tabs is lossless: free → structured calls `parseQuery(q)` to populate the form; structured → free calls `composeQuery` and writes the resulting string back to `q`. A hidden footer surfaces remaining free-text content (`+ free text: "…"`) so the user can see anything not bound to a structured field.

DSL helpers live in [site/src/lib/search-dsl.ts](../site/src/lib/search-dsl.ts) — `parseQuery(q)` and `composeQuery(s)`. A fast-check property test asserts the round-trip invariant: `parseQuery(composeQuery(s)) === s` for any `StructuredQuery` value (after trimming).

The `q` value is bounded by `Q_TOTAL_MAX = 256` (carried from v1.2.0) and `Q_FIELD_MAX = 64` per structured field. `composeQuery` throws if the composed length exceeds the cap.

#### Saved searches

A row of pills below the mode panel persists `q` snapshots to `localStorage` under `openroles:v1:saved-searches` ([site/src/lib/storage.ts](../site/src/lib/storage.ts)).

Storage shape:

```typescript
interface SavedSearch {
  id: string;        // sortable ISO-derived prefix + 4-char random tail
  label: string;     // 1–32 chars, trimmed
  q: string;         // 1–256 chars, trimmed
  createdAt: string; // ISO 8601
}
interface SavedSearches {
  version: 1;
  entries: SavedSearch[];   // newest first, capped at 12
}
```

`saveSearch(label, q)` de-dupes by exact `q` (newer label wins; older entry removed) and LRU-evicts the oldest entry when the cap would be exceeded. `removeSavedSearch(id)` removes by id. Empty / over-cap labels and empty `q` are rejected (`null` return).

The `+ Save current` trigger is `aria-disabled` whenever `q` is empty. Clicking it inline-replaces the trigger with a label input that accepts on `Enter` and cancels on `Escape` or blur.

When `savedSearches.length === 0` AND `q` is empty, the entire `.recent-row` is hidden (no orphan `RECENT` label).

### Filter (faceted) inputs (Phase 8 baseline)

The legacy Phase 8 description is preserved below for the per-filter contract; only the search surface changed in v1.3.1.

#### Advanced syntax (search DSL)

The search box parses `field:value` tokens before passing the result to
the in-memory predicate evaluator. The user-facing contract — what
shapes are accepted, what AND-semantics apply, what unrecognized fields
do — is unchanged from v1.2.0. Only the implementation moved (FTS5 SQL
→ regex `.test()` against `SlimRow` fields) when ADR-0012 retired the
runtime SQLite.

Four user-facing fields:

| User-facing field | Backing field on `SlimRow` | Match style |
|---|---|---|
| `title` | `title` | case-insensitive regex of the escaped value |
| `company` | `company` | case-insensitive regex of the escaped value |
| `description` | (no description field on `SlimRow`) | accepted for back-compat; matches nothing |
| `location` | `location_text` | case-insensitive substring (regex of escaped value) |

Token shapes:

- **Bare term** — `engineer`. Tested against `title`, `company`, and `location_text` simultaneously; row matches if any field hits.
- **Field-scoped term** — `title:engineer`, `location:remote`. Restricts the test to the named field.
- **Quoted phrase** — `"senior engineer"`. Whole phrase becomes a single regex; word boundaries are not implied.
- **Field-scoped phrase** — `title:"senior engineer"`, `location:"san francisco"`. Restricts the literal phrase to the named field.

Multiple tokens are **AND-joined**. `title:senior company:stripe location:remote` matches roles where the title contains *senior* AND the company contains *stripe* AND the location text contains *remote*. There is no `OR` syntax; that's deferred to a future spec.

A token whose field name is not in the recognized set (e.g. `xyz:engineer`) falls back to a bare-term match — the token is treated as a literal phrase with the colon embedded. This protects against new-syntax discovery surprises.

`description:` was a real field when search ran against the SQLite FTS5 virtual table; the slim-index intentionally drops the description column to keep the bundle small (see ADR-0012). The token is still parsed (so old shared-search URLs don't error) but matches nothing and short-circuits the row out — equivalent to a NOT-match for that token. A future revision may resurrect it by widening `SlimRow` if the size budget allows.

### Saved / applied / ignored sub-views (v1.2.0)

`localStorage["openroles:v1:saved"]` / `:applied` / `:ignored` already store `Job.id[]` ([site/src/lib/storage.ts](../site/src/lib/storage.ts)). The filter UI exposes a **single-select toggle** that narrows the result set to one of those lists:

- **None** (default): all roles, subject to other filters and the `Hide ignored` post-filter.
- **Saved**: only rows whose `id` is in the Saved set.
- **Applied**: only rows whose `id` is in the Applied set.
- **Ignored**: only rows whose `id` is in the Ignored set. Implicitly disables `Hide ignored` while active.

URL parameter: `show=saved | applied | ignored`. Omitted = none.

SQL synthesis: a single `id IN (?, ?, ...)` clause AND-joined into the WHERE. The id list is gathered at query time from the relevant `localStorage` slot and passed to `buildFilterQuery` via the second-arg `idAllowlist`. An empty allowlist (e.g. user toggled `+ Saved` with no saved roles yet) emits `id = ''` so the query returns zero rows — preferable to silently showing the unfiltered set.

The filter chip in the bar reads `+ SAVED · {n}` / `+ APPLIED · {n}` / `+ IGNORED · {n}` where `{n}` is the live count from `localStorage`. Toggling one off, or toggling another, clears the previous selection (single-select). When a sub-view is active, the result-status line prefixes with `SAVED ·` / `APPLIED ·` / `IGNORED ·`.

Why mutual exclusion: the three lists are disjoint by intent — a role typically isn't simultaneously saved-and-applied-and-ignored. A multi-select would create odd intersections (saved AND applied = applied with a star) that are better expressed as separate views than one combined query. If we ever need the intersection (e.g. "saved AND not yet applied") we'll spec it as a derived view rather than as additive multi-select.

Predicate synthesis (in-memory):

```ts
const tokens = parseSearchInput(state.q);
const compiled = tokens.map(t => ({
  field: t.field,
  regex: new RegExp(escapeRegExp(t.value), "i"),
}));

// Per-row, per-token: the row matches the token iff its named field
// (or any of title/company/location_text for an unscoped token)
// passes regex.test. AND across tokens; OR within a single unscoped
// token's three candidate fields.
```

Every `value` is `escapeRegExp`'d before compilation, so regex
metacharacters (`.`, `*`, `+`, `?`, `(`, `[`, `\`, etc.) inside a value
match literally — `50%` and `r&d` and `c++` all behave as plain text.
The flag set is `i` only; no `u`, no `g`. There is no anchored or
boundary matching.

Round-trip and safety invariants:

- The user input is never passed verbatim to a regex constructor — `escapeRegExp` runs first.
- The parser bounds the token list at 16 to short-circuit pathological inputs.
- An empty value (`title:`) drops the token. A token whose value is only whitespace drops too.
- Unicode in values survives the regex-escape unchanged; case-insensitive matching uses the JS `i` flag, which folds ASCII case but not full Unicode (good enough for ATS title text).
- The parser is **idempotent on the bare-term path**: parse-and-reemit of free text produces the same token list, so existing shared search URLs continue to behave identically.

Implementation: [site/src/lib/search-parser.ts](../site/src/lib/search-parser.ts) — pure functions `parseSearchInput(raw): Token[]`, `buildFtsExpression(tokens): string | null`, and `extractLocationLikes(tokens): string[]`. Property tests cover the safety invariants in [site/src/lib/search-parser.test.ts](../site/src/lib/search-parser.test.ts).

### Faceted filters

Multi-select where applicable, single-select where the data is one-of:

| Filter | Type | Source field |
|---|---|---|
| ATS | multi-select | `jobs.ats` |
| Level | multi-select | `jobs.level` |
| Workplace type | multi-select | `jobs.workplace_type` |
| Country | single-select with autocomplete | `jobs.location_country` |
| Region | single-select, gated on country | `jobs.location_region` |
| Posted within | single-select (24h, 7d, 30d, all) | `jobs.posted_at` |
| Show only | single-select (saved, applied, ignored, none) | `localStorage` lookup → `jobs.id IN (...)` |
| Hide recruiter posts | boolean | `jobs.is_recruiter_post` |
| Compensation min | numeric input | `jobs.compensation_min` |

### Sort

Single-select; default `posted_at DESC`. Options:

- `posted_at DESC` (default)
- `posted_at ASC`
- `first_seen_at DESC`
- `company ASC`
- `company DESC`
- `level ASC` — junior to senior. Implemented via a derived `level_rank` integer (see [data-schema.md](data-schema.md)) since the `Level` enum text column does not sort meaningfully.

### Pagination

50 rows per page on desktop, 25 per page on mobile. URL carries `page` 1-indexed.

## URL state

All filter state encodes into a single URL query string. Deep-linkable, shareable, refreshable.

| Param | Encoding |
|---|---|
| `q` | URL-encoded raw search input |
| `ats` | comma-separated `ATSId` values |
| `level` | comma-separated `Level` values |
| `wt` | comma-separated `WorkplaceType` values |
| `country` | ISO 3166-1 alpha-2 |
| `region` | URL-encoded subdivision |
| `since` | one of `24h`, `7d`, `30d`, `all` |
| `recruiter` | `0` (hide) or omitted (show); never `1` |
| `min_comp` | integer cents |
| `sort` | `posted_at:desc`, `posted_at:asc`, `first_seen:desc`, `company:asc`, `company:desc`, `level:asc` |
| `page` | 1-indexed integer |

Round-trip invariants:

- Encoding then decoding the same filter state yields an identical state object.
- Empty / default values are omitted from the URL (no `?ats=&level=&page=1`).
- Unknown params are ignored, not rejected — forward-compatible.
- Out-of-range `page` clamps to the last valid page.

## localStorage contract

Three lists, namespaced under `openroles:v1:`:

- `openroles:v1:saved` — `string[]` of `Job.id`
- `openroles:v1:applied` — `string[]` of `Job.id` with optional timestamp
- `openroles:v1:ignored` — `string[]` of `Job.id`

Schema:

```typescript
interface SavedJobs {
  version: 1;
  ids: string[];
}
interface AppliedJobs {
  version: 1;
  entries: Array<{ id: string; applied_at: string /* ISO 8601 */ }>;
}
interface IgnoredJobs {
  version: 1;
  ids: string[];
}
```

Migration on schema bump: read the old version, transform, write the new version, retain a backup under `openroles:vN-prev:*` for one release cycle.

## Layout (v1.3.0 — sidebar + sheet)

The filter UI breaks at `--bp-sidebar: 800px` (defined in [tokens.css](../site/src/styles/tokens.css)). The 800 px breakpoint diverges from the 768 px type-scale ramp because the sidebar + results pair needs ~800 px to breathe; see [specs/uplift-v2-handoff.md](uplift-v2-handoff.md) §2.6 for rationale.

### Desktop presentation (≥ 800px)

- Persistent sidebar at `width: 280px` (320 px at ≥ 1280 px), bordered with `var(--rule-2) solid var(--color-ink)`, sticky to the page top.
- Each filter group renders as a `<section>` with an `<h3>` title (display sans, uppercase, `var(--rule-2)` bottom rule) and an active count in `--color-accent` mono when ≥ 1.
- Results render to the right in a single column, sortable column headers retained (`<table>`-style grid at ≥ 960 px).
- Reset-all sits in the sidebar footer; confirmation prompt only appears when `activeFilterCount ≥ 3`.

### Mobile presentation (< 800px)

- Filters live behind a single `FILTERS · n` button in a bar above the results, alongside the sort dropdown and live role count.
- Tapping `FILTERS` opens a bottom sheet: `<div role="dialog" aria-modal="true" aria-label="Filters">` slides up from the viewport bottom with the same group structure as the sidebar, plus a sticky footer with `Reset` and `Show N roles` buttons.
- Group headers are also collapse toggles on mobile only — per-group expansion persists in `localStorage` under `openroles:filter-group:{id}` ([site/src/lib/group-storage.ts](../site/src/lib/group-storage.ts)).
- The sheet DOM is mounted continuously (not gated on `open`) so opening / closing costs only a CSS transition — `transform: translateY(100%) → 0` over 180 ms `cubic-bezier(.25,0,.4,1)` on open, 120 ms `ease-in` on close. Re-mount of the seven group children + ~50 chips on every open would feel slow.
- Focus moves to the close button on open; `Esc` closes; `Tab` is trapped inside the sheet.
- All tap targets ≥ 44 × 44 px.

### Components

- [FilterTable.svelte](../site/src/components/FilterTable.svelte) is the orchestrator: viewport-aware (`window.matchMedia(--bp-sidebar)`), owns `FilterState`, runs queries, renders results.
- [FilterSidebar.svelte](../site/src/components/filter/FilterSidebar.svelte) — desktop sidebar shell.
- [FilterSheet.svelte](../site/src/components/filter/FilterSheet.svelte) — mobile bottom-sheet shell.
- [FilterGroups.svelte](../site/src/components/filter/FilterGroups.svelte) — shared group sequence used by both shells.
- Per-group children: `AtsGroup`, `LevelGroup`, `WorkplaceGroup`, `PostedGroup`, `MinCompGroup`, `StatusToggles`, `PersonalToggles` (one file each in `site/src/components/filter/`). Each receives a `Pick<FilterState, ...>` slice plus an `onPatch(patch: Partial<FilterState>) => void` callback; no group owns network state.
- [ChipList.svelte](../site/src/components/filter/ChipList.svelte) — shared multi-select chip rendering with optional inline group-search (renders when `options.length > 8`) and progressive disclosure (`Show all N` at `> 6`).
- [GroupCard.svelte](../site/src/components/filter/GroupCard.svelte) — shared title + active-count + collapse-toggle chrome.
- Active-count derivation: pure helpers in [site/src/lib/filter-active-count.ts](../site/src/lib/filter-active-count.ts) — `activeCountFor(group, state)` and `totalActiveCount(state)`. Property tests assert that the total equals the sum of per-group counts for any state, that the count is non-negative, and that a default state yields zero.

## Accessibility

- Every filter control has a `<label>` and an accessible name.
- Active filters render as removable chips with `aria-label="Remove filter: …"`.
- Sort headers announce direction via `aria-sort`.
- The Save / Apply / Ignore buttons announce state via `aria-pressed`.
- Empty results announce via `aria-live="polite"` so screen readers don't get stuck on the previous result list.
- Keyboard navigation: `Tab` cycles filters, `Enter` toggles, `Esc` closes the mobile drawer.
- Focus management on drawer open/close traps focus inside the drawer until dismissed.

## Performance

- The filter island hydrates with `client:idle`, never `client:load`, so initial paint is unblocked.
- The runtime data path is the slim-index, not SQLite. A Web Worker fetches each `data/slim/*.json.gz` chunk, gunzips it, and posts the parsed rows back to the main thread; the chunk filenames are content-hashed so the browser HTTP cache holds them for the lifetime of the build. Service-worker cache (`sw.js`) makes revisits cost ~0 bytes for the slim-index payload.
- Filter / sort / search / pagination are all in-memory operations on the merged `SlimRow[]`. There is no SQL at runtime and no parameterised query path to defend against — the only escapable input is the regex `value` payload of a search token, and `escapeRegExp` runs before any `RegExp` construction.
- Filter passes are debounced 250 ms on search input and throttled 1500 ms on chunk-merge updates. A busy indicator paints before each synchronous pass so a long sort on a 750k-row dataset reads as "loading" rather than "frozen".

## Rejection cases

- A search input longer than 256 chars is truncated client-side before the query.
- A `q` value containing only FTS5 operator characters is treated as empty.
- A `min_comp` value below 0 or above 10⁹ cents is clamped before query.
- Unknown sort values fall back to the default `posted_at:desc`.

## Canonical example URL

```
/?q=engineer&ats=greenhouse,lever&level=senior,staff&wt=remote&since=7d&recruiter=0&sort=posted_at:desc&page=1
```

This loads: postings matching "engineer" across Greenhouse and Lever tenants at senior or staff level, remote-friendly, posted in the last 7 days, recruiter posts hidden, sorted by recency, first page.
