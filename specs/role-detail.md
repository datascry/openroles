# Spec: Role detail page

**Version**: 3.1.0
**Status: SUPERSEDED by [ADR-0012](../docs/adr/0012-static-only-deployment.md)**

> [!IMPORTANT]
> This spec describes a feature that no longer exists. The per-role
> detail page (`/role/?id=…`) and its `sql.js-httpvfs` runtime were
> both removed in **ADR-0012 (static-only deployment)**. The row's
> primary action (the role title and the Apply CTA) now links
> directly to the source ATS in a new tab — there is no intermediate
> openroles-hosted page for an individual role.
>
> The text below is preserved for historical context only. Do not
> implement against it; do not link to it from new code or specs.
> If you need the rationale for removing the page, read ADR-0012.

---

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
- `site/src/components/RoleDetail.svelte` — client-fetch + render (v3.1.0
  editorial layout per `specs/uplift-v2-handoff.md` §3)
- `site/src/lib/role-detail-sql.ts` — `buildRoleByShortIdQuery`,
  `isShortId`, `shortIdFromJobId` (shared with FilterTable for the
  view-link generation)
- `site/src/lib/role-detail-format.ts` — `bylineParts(role)` and
  `pullquote(role)` formatters
- `site/src/lib/role-related-sql.ts` — `buildRelatedRolesQuery` /
  `buildRelatedRolesCountQuery` for the "More from {company}" card
- `site/src/lib/client-db.ts` — sql.js-httpvfs runtime (already exists)

## Layout (v3.1.0 — editorial broadsheet)

Per `specs/uplift-v2-handoff.md` §3. Replaces the previous unstyled column
with a feature-article layout: kicker (company in accent mono), display
headline (role title in 48–64 px display sans), serif strap (italic first
sentence), byline rule (level · workplace · department · comp · ats), then
a two-column body with narrative + dropcap on the left and an apply card +
fact card + "More from {company}" on the right rail.

States covered: deterministic skeleton during load (no shimmer per
editorial tone), themed error block inside the same frame, stale banner,
recruiter line, sticky bottom apply bar on mobile when the in-flow card
scrolls out, pullquote that omits when there is no comp data and appends
`+ EQUITY` when the description excerpt mentions equity (substring,
case-insensitive), fact rows that render `not stated` (italic serif) for
missing fields rather than dropping them.

A local-state disclosure paragraph below the body explains that
saved/applied/ignored states live in the browser only — this addresses the
prior critique's hidden-state finding.

Print stylesheet hides the rail-top, apply card, "more from" card, and
disclosure; the fact card renders inline above the body.

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
