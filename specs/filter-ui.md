# Spec: Filter UI

**Version**: 1.2.0

The filter UI is the primary interactive surface. It runs as a Svelte island hydrated with `client:idle` over a static Astro page. State lives in two places: the URL query string (shareable, deep-linkable) and `localStorage` (saved/applied/ignored).

## Implementation status (as of Phase 8)

The runtime contract below is the design target. What ships today, plus what is deferred:

**Shipped:**
- Search input with 250 ms debounce
- ATS / Level / Workplace multi-select chips
- Sort dropdown (all 6 options)
- Hide-recruiter toggle
- URL ↔ FilterState round-trip via `history.replaceState`
- sql.js-httpvfs runtime — Worker boots on `client:idle`, fetches `data/manifest.json`, queries SQLite over HTTP `Range` requests
- Loading / empty / per-query-error / terminal-load-error states
- `aria-live="polite"` results-status; `role="alert"` on terminal errors

**Deferred (no UI surface, but state model exists):**
- Pagination controls — `state.page` round-trips through the URL but no pager renders. LIMIT 50 caps unreachable pages.
- Country / region / since-window / min-comp inputs
- Save / Apply / Ignore lists (localStorage helpers exist in `lib/storage.ts`; no UI)
- Mobile bottom-sheet drawer for filters (chips render inline on all viewports today)
- Desktop `<table>` with sortable column headers (cards on all viewports today)

## Runtime contract

1. Astro pre-renders the page with the filter shell + a manifest-pending placeholder.
2. The Svelte island hydrates on `client:idle`, calls `loadClientDb({ basePath })` which:
   - Fetches `${basePath}/data/manifest.json` with `cache: "no-cache"`.
   - Validates the response shape via `parseManifest` (per-field type + regex checks; cross-checks `db_filename` against `short_sha`).
   - Dynamic-imports `sql.js-httpvfs` (kept out of the main bundle).
   - Calls `createDbWorker` against `${basePath}/sqlite-vfs/sqlite.worker.js` and `sql-wasm.wasm`, with `requestChunkSize: 1024` matching the build-time `pragma page_size = 1024` from ADR-0002.
3. A Svelte 5 `$effect` re-runs the query whenever `clientDb` is non-null, `dbStatus === "ready"`, and any read-tracked field of `state` changes. Each run issues two parallel queries (rows + count) via `buildFilterQuery` / `buildFilterCountQuery`.
4. A monotonic `queryToken` discards stale results — fast successive state changes don't clobber the freshest query.
5. Per-query failures populate `queryError` (rendered inline above results) without latching the panel; the worker stays live for the next attempt. Terminal Worker-bootstrap or manifest-fetch failures set `dbStatus = "error"` and render a `role="alert"` panel — that state is intentionally non-recoverable without a page reload.

## Visible behavior

### Search

- A single text input drives FTS5 over `jobs.title`, `jobs.company`, and `jobs.description_excerpt`.
- Input is debounced at **250 ms** before a query fires.
- Empty search returns the unfiltered view (subject to other filters).
- The input accepts a small **field-scoped syntax** (Phase 13) for power users; plain text falls through to the prior all-column phrase match.

#### Advanced syntax (v1.2.0)

The search box parses `field:value` tokens before passing the result to the SQL builder. Four user-facing fields, three of them backed by FTS5 phrase match and one by case-insensitive substring match on a regular column:

| User-facing field | Backing column | Match style |
|---|---|---|
| `title` | `jobs.title` | FTS5 phrase |
| `company` | `jobs.company` | FTS5 phrase |
| `description` | `jobs.description_excerpt` | FTS5 phrase |
| `location` | `jobs.location_text` | `LIKE '%value%' COLLATE NOCASE` |

Token shapes:

- **Bare term** — `engineer`. Treated as a phrase across the three FTS5 columns.
- **Field-scoped term** — `title:engineer`, `location:remote`. Restricts the match to the named field's backing column with the field's match style.
- **Quoted phrase** — `"senior engineer"`. Matches the literal phrase in any FTS5 column.
- **Field-scoped phrase** — `title:"senior engineer"`, `location:"san francisco"`. Restricts the literal phrase to the named field.

Multiple tokens are **AND-joined**. `title:senior company:stripe location:remote` matches roles where the title contains *senior* AND the company contains *stripe* AND the location text contains *remote*. There is no `OR` syntax; that's deferred to a future spec.

A token whose field name is not in the recognized set (e.g. `xyz:engineer`) falls back to a bare-term match — the token is treated as a literal phrase with the colon embedded. This protects against new-syntax discovery surprises.

Why `location` uses LIKE instead of FTS5: `location_text` is free-form ATS data ("San Francisco, CA · Remote", "Worldwide", "EU only") that doesn't benefit from porter stemming. Substring match gives users predictable behavior — `location:remote` matches anywhere the substring appears, including hybrid postings ("Hybrid · Remote-friendly"). Adding `location_text` to the FTS5 virtual table is reserved for a future spec if we want relevance ranking on location.

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

SQL synthesis (search modifiers):

```
WHERE rowid IN (SELECT rowid FROM jobs_fts WHERE jobs_fts MATCH ?)   -- FTS5 tokens
  AND location_text LIKE ? COLLATE NOCASE                            -- per location token
  AND ...                                                            -- existing facets
```

`LIKE` parameter is `%value%` with the four LIKE meta-characters (`%`, `_`, `[`, `\`) escaped to a literal class — values like `50%` or `r&d` cannot turn into wildcards.

Round-trip and safety invariants:

- The user input is never passed verbatim to FTS5 or SQL. Every emitted FTS5 phrase is double-quoted with internal `"` doubled to `""`. FTS5 operators (`AND`, `OR`, `NEAR`, `^`, `*`) inside a value are inert because they sit inside a phrase. LIKE values are escaped + parameterized.
- The parser bounds the token list at 16 to short-circuit pathological inputs.
- An empty value (`title:`) drops the token. A token whose value is only whitespace drops too.
- Unicode in values survives quoting / LIKE-escaping unchanged.
- The parser is **idempotent on the bare-term path**: parse-and-reemit of free text produces the same FTS5 phrase the v1.1.0 codepath produced. Existing user behavior is preserved.

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

## Mobile presentation (≤ 768px)

- Job list renders as `<ul role="list">` of cards (one card per job).
- Filter controls live in a bottom-sheet drawer (`FilterDrawer.svelte`) toggled by a fixed-position button.
- Search input is at the top of the viewport, persistent on scroll.
- Pagination is "Load more" infinite-scroll trigger, not a numbered pager (smaller tap targets work poorly for pagination).
- All tap targets ≥ 44×44 px.

## Desktop presentation (≥ 768px)

- Job list renders as a `<table>` with sortable column headers.
- Filter controls live in an inline left sidebar.
- Search input is a header element; sticky on scroll.
- Pagination is a numbered pager.

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
- Each query reads SQLite via `sql.js-httpvfs`; range fetches are cached by the browser HTTP cache for the lifetime of the SQLite filename (which is content-hashed).
- The query result for the visible page is held in memory; pagination beyond the visible page issues a fresh query.
- No SQL is constructed by string concatenation. Parameter binding is mandatory; the linter rejects template-string SQL.

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
