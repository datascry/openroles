# Spec: Role detail page

**Version**: 3.0.0

A client-rendered detail view for a single role, addressable by query string
URL `/role/?id=<short_id>`. The page is a static HTML shell that hydrates a
Svelte component which queries the SQLite via `sql.js-httpvfs` (the same
runtime FilterTable uses for the index) and populates the page from the row.

## Why client-rendered (not pre-rendered)

The previous version (v2.0.0) emitted one HTML file per job at build time —
shareable, indexable, full Google for Jobs JSON-LD. That worked at the early
corpus size of ~30-50k jobs (build < 10 min). It does **not** scale: at the
post-bootstrap 119k-tenant corpus the projected per-job page count is
~400k+, which exceeds both:

- the GitHub Actions runner's 30-min build cap (Astro `getStaticPaths` over
  400k jobs takes ~100 min on the standard runner)
- the GitHub Pages 1 GB soft cap on deployed-artifact size (per-role HTML
  averages ~5-10 KB; 400k × 7.5 KB ≈ 3 GB)

The static-prerender path was the right call at the original corpus size
and is the wrong call at this one. The break-even is somewhere around
~75k-100k jobs depending on runner generation.

## What we keep, what we trade

**Keep**:
- Stable per-role URL (now `/role/?id=<short_id>` instead of
  `/role/<short_id>/`) — bookmarkable, shareable
- Save / mark-applied / ignore localStorage actions
- Themed inline error for unknown ids (rendered by RoleDetail when the
  query resolves to zero rows)
- All the chrome (Masthead, footer, theme toggle) from BaseLayout

**Trade away**:
- Static HTML for crawlers: per-role pages now carry a `noindex,follow`
  meta. Google for Jobs will not pick up individual postings (they need
  static URLs with JSON-LD JobPosting in the initial HTML response).
- Slack / Twitter unfurls: the page renders empty until JS runs, so
  unfurls show only the generic site title + description.
- No-JS users: the page shows a loading message and never resolves
  without JavaScript.

The index page (`/`) and per-tenant pages (`/tenant/<ats>/<slug>/`) remain
statically rendered and indexable. Those are the SEO entry points.

## URL shape

- **Canonical**: `/role/?id=<short_id>` where `short_id` is the first 16
  hex chars of `Job.id` (SHA-256 over `(ats, tenant_slug, source_id, url)`).
- **Legacy compatibility**: the `RoleDetail` component also accepts
  `/role/<short_id>/` paths via a fallback regex on `window.location.pathname`,
  for any pre-v3 deep links still in the wild. GitHub Pages 404s on those
  paths will fall through to a themed 404 (no static `[short_id].astro`
  exists at v3 to catch them); operators sharing fresh links should use
  the canonical `/role/?id=...` form.

## Build cost

- One static HTML file (`/role/index.html`)
- No `getStaticPaths` enumeration
- Build time: < 1 second

## Implementation files

- `site/src/pages/role/index.astro` — static shell that mounts the Svelte
  island
- `site/src/components/RoleDetail.svelte` — client-fetch + render
- `site/src/lib/role-detail-sql.ts` — `buildRoleByShortIdQuery`,
  `isShortId`, `shortIdFromJobId` (shared with FilterTable for the
  view-link generation)
- `site/src/lib/client-db.ts` — sql.js-httpvfs runtime (already exists)

## Tests

`site/tests/e2e/role-detail.spec.ts`:
1. Title + company + description appear after client hydration
2. `<title>` reflects the loaded role for share-unfurls (best-effort,
   only after JS runs)
3. `meta[name="robots"]` carries `noindex`
4. Save button toggles `openroles:v1:saved` localStorage
5. Unknown short id renders the inline error message
6. axe-core a11y check on the rendered page

## Migration history

- **v1.0.0**: client-rendered SPA route at `/role/?id=...`. Shipped with
  the initial site scaffold.
- **v2.0.0**: static prerender at `/role/<short_id>/` (one HTML per job).
  Added Google-for-Jobs JSON-LD. Worked through ~30-50k jobs.
- **v3.0.0** (this version): client-rendered single shell at `/role/?id=...`.
  Reverted from v2 because the post-bootstrap 119k-tenant corpus made the
  static prerender economically infeasible (~3 GB output, ~100-min build).
  When/if the static-prerender path returns, it should be hybrid:
  prerender only the most recent N days of jobs; older fall through to the
  client route.
