# Spec: Role detail page

**Version**: 1.0.0

A client-rendered detail view for a single role, addressable by stable URL. Used for
direct sharing (Slack/Twitter/email), bookmarking, and "open in new tab" from the list
view. **Not a SEO investment**: the canonical source for every role is its ATS, and we
do not compete with the first-party listing for indexability. See
docs/adr/0011-incremental-harvest-and-reprobe.md and the SEO-value discussion in the
project journal.

## Goals

1. **Shareable.** Pasting a URL into Slack/Twitter/email yields a recognisable
   preview (OG + Twitter Card) and renders the role for the recipient.
2. **Bookmarkable.** Users can save a specific role's URL outside our save-list.
3. **Internal navigation.** "View" link from the list view goes to a real URL,
   keeping browser history clean.
4. **Free for the build.** Zero per-role build cost; fully client-rendered from the
   already-loaded SQLite. No new pages added to `getStaticPaths`.

Explicit non-goals:

- Not indexable as a search result. We deliberately set `<meta name="robots" content="noindex">`
  to avoid duplicate-content penalties and to keep crawl budget on the list/topic
  pages where we want to rank.
- Not a Google for Jobs target. Our pages would lose the canonical battle to the ATS
  itself, and stale-role 404s would hurt the rest of the site.
- No comments, ratings, or other engagement features. The role record is read-only.

## URL shape

`/role/?id=<short_id>`

- `<short_id>` is the first 16 hex chars of the canonical `Job.id` SHA-256 (64-bit
  space; no realistic collision risk across ~10^5 active rows).
- Query-param shape, not path-based, so static hosting on GitHub Pages requires no
  404-fallback trick. Path-based routing is a possible later enhancement once a
  Pages 404 SPA shell is wired (out of scope here).
- The `id` is stable across rebuilds because `Job.id = sha256(ats, tenant_slug,
  source_id, url)` and all four inputs are immutable for a given posting.

## Architecture

A single static Astro page hydrates a Svelte island that reads `?id=` from
`window.location.search`, runs one SQL query against the already-loaded SQLite via
`sql.js-httpvfs`, and renders the role.

```
site/src/pages/role.astro          (static shell, prerender = true)
site/src/components/RoleDetail.svelte  (client:idle island)
site/src/lib/role-detail-sql.ts    (SQL builder, pure)
```

### Build-time

`role.astro` renders:

- `<head>`: title placeholder ("Role · openroles"), canonical/OG/Twitter Card
  placeholders that the island replaces post-mount, and `noindex,nofollow` for
  robots (see Goals).
- `<body>`: skeleton placeholder, the `<RoleDetail>` Svelte mount point, and the
  shared site chrome from `BaseLayout.astro` (header, footer, theme toggle).

### Run-time

`RoleDetail.svelte` mounts on `client:idle`, then:

1. Reads `id` from `URL` constructor on `window.location`.
2. Validates `id` matches `/^[0-9a-f]{16}$/`. Invalid → renders the not-found state.
3. Awaits the shared sql.js-httpvfs worker (re-uses the same singleton the filter UI
   boots; new initialiser if the user lands here cold).
4. Runs `SELECT … FROM jobs WHERE substr(id, 1, 16) = ? LIMIT 1`. Worker streams
   the SQLite over HTTP-Range; query is page-bounded.
5. On hit: renders the role and replaces `<head>` meta (title, OG image hint,
   description excerpt for unfurl previews) via DOM mutation.
6. On miss (no row matched): renders the expired/not-found state. Distinguishes
   "id-shaped but not in the index" (likely expired) from "not id-shaped".

## Data shape

Single row, all columns we already select in the list view:

| Column | Used for |
|---|---|
| `id` | Save / Apply / Ignore localStorage key |
| `ats` | "View on Greenhouse" attribution + apply-button label |
| `tenant_slug` | Cross-link to `/tenant/{ats}/{slug}` |
| `title` | Page heading + `<title>` + OG/Twitter title |
| `company` | Subheading + OG/Twitter site_name |
| `description_excerpt` | Body (when present) |
| `level`, `level_rank` | Level chip |
| `workplace_type` | Workplace chip |
| `is_recruiter_post` | Subtle "agency" indicator |
| `location_text`, `location_country`, `location_region` | Location line |
| `compensation_min`, `compensation_max`, `compensation_currency` | Comp range when present |
| `department` | Department line |
| `posted_at`, `first_seen_at`, `last_seen_at` | "Posted X ago", "Seen Y days" |
| `is_stale` | Stale banner (carry-forward from previous build) |
| `url` | Apply button — opens in new tab with `rel="noopener noreferrer"` |

The query mirrors the list-view selection list in `site/src/lib/db.ts`. SQL builder
in `role-detail-sql.ts` is a thin wrapper to keep the binding parameterised.

## UI

Mobile-first, single column, generous line-height. No two-column layout — the
description is the only long block and reads better full-width.

```
[ ← Back to roles ]                                    [ ☆ Save ] [ ⤴ Apply on Greenhouse ]

  Senior Software Engineer
  Stripe · Engineering · Senior · Remote (US)

  Posted 4 days ago · First seen 4 days ago

  $180,000 – $260,000 USD                              <-- when comp range present

  ⓘ This role was carried forward from a previous build  <-- when is_stale = true

  Description
  ───────────
  Lorem ipsum dolor sit amet… (description_excerpt)

  ─────────────────────────────────────
  [ ⤴ Apply on Greenhouse ]
  Source: boards.greenhouse.io/stripe/jobs/1234567
  This page is not the canonical posting; the apply link goes to the company's ATS.
```

Stale/expired states render the chrome but replace the body with:

- `is_stale=true` row found: full body + small banner.
- No row found: "This role isn't in the current build. It may have been filled or
  withdrawn. Search active roles." + link back to `/openroles/` + suggested
  filters (recent roles at the same tenant if known from the URL referrer; fall
  back to "see all roles").

Loading, error, and not-found states mirror `FilterTable.svelte` patterns:
`role="status"` and `aria-live="polite"` on the loading skeleton; `role="alert"`
on terminal errors.

## Save / Apply / Ignore

Re-uses the existing `site/src/lib/storage.ts` helpers without modification. The
toggle buttons in the header and footer of the role page bind to the same
localStorage keys the list view uses. No data migration needed.

State changes update the button labels in place; the toolbar in the list view
will reflect the change on next visit (it already reads from localStorage on
mount).

## Apply attribution

The "Apply" button links to the role's canonical `url` field — `boards.greenhouse.io/...`,
`jobs.lever.co/...`, etc. We do **not** add referral / tracking parameters. The
attribution line below the button discloses where the apply flow goes:

> Apply on **{ATS pretty-name}** · Source: `{host of url}` · This page is a filtered
> view of the original posting on the company's ATS.

This is honest about our role as an aggregator and avoids any user surprise about
where the form lives.

## Share-card meta

The Astro page renders default placeholders; the Svelte island replaces them on
mount. For users who hit the URL directly the placeholders unfurl correctly even
before JS runs (good for headless link-checkers and slow networks).

| Meta | Default (static) | After hydration |
|---|---|---|
| `<title>` | `Role · openroles` | `{title} at {company} · openroles` |
| `<meta name="description">` | `A specific role on openroles. Loading…` | First 280 chars of `description_excerpt` |
| `<meta property="og:title">` | `openroles` | `{title} at {company}` |
| `<meta property="og:description">` | _(empty)_ | description excerpt |
| `<meta property="og:type">` | `website` | `website` (kept simple; no JobPosting type since we noindex) |
| `<meta name="twitter:card">` | `summary` | `summary` |
| `<meta name="robots">` | `noindex,nofollow` | `noindex,nofollow` |
| `<link rel="canonical">` | _(omitted)_ | the role's ATS `url` (signals to any crawler that the canonical posting lives at the ATS) |

Slack/Twitter/Discord crawlers don't run JS so they see the static placeholders;
that's acceptable for a non-SEO surface. If we later want pretty unfurls we can
swap to a tiny edge function that renders the meta server-side, but that's out of
scope for this iteration.

## Performance budget

- **First contentful paint**: < 200 ms (static shell only).
- **Time to role visible**: < 1.5 s on a warm SQLite cache, < 4 s cold (the
  worker pulls a few SQLite pages over HTTP-Range; the WHERE on `substr(id, 1,
  16)` uses the existing `idx_jobs_id` index).
- **Bundle delta**: < 4 KB gzipped. Reuses the worker, the SQL builder is a few
  dozen lines, the Svelte component is small.

## Tests

Unit (TDD, ≥ 95% line / 90% branch per CLAUDE.md):

- `role-detail-sql.test.ts`: SQL injection round-trip; correct column list;
  16-char prefix binding shape.
- `role-detail.test.ts` (Svelte): renders skeleton on mount; renders role on
  worker resolve; renders not-found on empty result; renders error on worker
  reject; updates `<head>` meta; toggles save/apply state in localStorage.

E2E (Playwright):

- Navigate to `/role/?id={valid}`: title appears, apply button has correct
  `href` and `target="_blank"`.
- Navigate to `/role/?id={invalid-shape}`: not-found state renders without
  hitting the worker.
- Navigate to `/role/?id={valid-shape-but-missing}`: expired state renders.
- Lighthouse performance run on the role page in CI: best-practices and a11y
  ≥ 95.

## Failure modes

- **Worker fails to load** (CSP, network): renders the same terminal-error state
  the list view uses.
- **`?id=` collides** (16-char prefix matches two rows): `LIMIT 1` returns the
  first; we accept this since the probability of collision in 64 bits across
  ~10^5 rows is ~3 × 10^-10. If we ever cross 10^6 rows we'll widen to 24
  chars (still room in the URL budget).
- **JS disabled**: shell renders, body shows "JavaScript is required for the
  role detail view. View this role on `{ATS link from URL would be empty here}`."
  — actually since we have no `id→url` map without JS, we instead point users
  back to the list view. Acceptable for a fully-static, JS-required SPA.
- **Stale role re-discovered**: a role flagged `is_stale=true` shows the banner;
  no behavioural difference. The apply link still goes to the ATS, which may
  itself 404 — that's the ATS's problem, not ours.

## Implementation phasing

1. **MVP**: `role.astro` + `RoleDetail.svelte` + `role-detail-sql.ts` + the
   loading/found/expired states. Save/Apply/Ignore re-uses existing storage.
2. **Polish**: meta tag hydration, share-card defaults, `aria-live` regions,
   "back to results" link that preserves the previous filter state via
   `document.referrer` parsing.
3. **Cross-link**: list-view rows get a "view" link to `/role/?id=...`. The
   apply button on the list-view stays as today (deep-link to ATS) so the
   list flow is unchanged for users who never want the detail page.

Phase 1 is the only one needed to unblock sharing; phases 2 and 3 are quality of
life.

## Open questions

- **Hash vs query**: `?id=...` works on any static host without 404 fallback
  config. `#id=...` would be friendlier to caching (URL doesn't change cache
  key). Picked `?id=` for cleaner share-card unfurls (some crawlers ignore the
  hash). Revisit if cache invalidation becomes a real cost.
- **History entry on list → detail**: should the detail page push a new history
  entry, or replace the current one? Default to push so the back button returns
  to the list with filters intact. Replace would be needed only if we adopted
  hash routing later.
- **Future SEO pivot**: if the SEO calculus changes (e.g. we acquire enough
  domain authority to compete with first-party ATSes), this spec can flip from
  client-rendered + noindex to per-role static + JSON-LD JobPosting in a
  separate version. The route shape and id format are forward-compatible.
