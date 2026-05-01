# Spec: Role detail page

**Version**: 2.0.0

A statically-rendered detail view for a single role, addressable by stable
URL. Each role gets a fully-rendered HTML page at build time so social /
Slack / Twitter unfurls work, non-Google crawlers index real content, and
Google for Jobs picks up the JSON-LD `JobPosting` from the very first
crawl pass.

## Goals

1. **Shareable.** Pasting a URL into Slack / Twitter / email yields an
   unfurl with the real role title and company, and the recipient sees
   the full content immediately (no JS required).
2. **Indexable.** `<meta name="robots" content="index, follow">` (the
   `BaseLayout` default) plus inline `JobPosting` structured data make
   the page eligible for Google for Jobs and long-tail
   "{company} + {title}" searches.
3. **Bookmarkable.** Stable URLs survive across rebuilds because
   `Job.id` is a SHA-256 over `(ats, tenant_slug, source_id, url)` —
   all four inputs are immutable for a given posting.
4. **Internal navigation.** "View" link from the list view goes to a
   real URL, keeping browser history clean.

Explicit non-goals:

- No engagement features (comments, ratings). The role record is read-only.
- No SSR or edge runtime. The page is fully static; the only client-side
  code is the `RoleActions` island for save / apply / ignore toggles.
- No alternative apply flow. The "Apply on {ATS}" CTA links straight to
  the ATS's canonical posting; openroles does not host applications.

## URL shape

`/role/<short_id>/`

- `<short_id>` is the first 16 hex chars of `Job.id` (SHA-256 hex).
  64-bit collision space; ~3 × 10⁻¹⁰ collision probability across 10⁵
  active rows.
- Path-based — Astro `getStaticPaths()` emits
  `/role/<short_id>/index.html` for each enumerated role at build time.
  No query-param parsing, no 404-fallback hack.
- Stale roles: when a role drops from the SQLite, its directory simply
  isn't emitted on the next build — the URL returns the themed
  `404.astro` page. No cleanup logic; the artifact-replace deploy model
  handles GC for free.

## Architecture

```
site/src/pages/role/[short_id].astro    prerender=true; getStaticPaths walks all jobs
site/src/components/RoleActions.svelte  client:idle; save/apply/ignore buttons only
site/src/lib/role-detail-sql.ts         shortIdFromJobId helper (16-char prefix)
site/src/lib/db.ts                      selectAllJobsForStatic helper (build-time)
site/src/lib/json-ld.ts                 jsonLdSafe helper (HTML-script-context escape)
```

Astro renders the entire page (title, company, description, location,
comp, dates, JSON-LD JobPosting, apply CTA) at build time from the row
passed via `getStaticPaths` props. The Svelte island is small (~50 lines)
and only handles the localStorage save / apply / ignore toggles — no
SQLite query at runtime, no Worker boot, no meta mutation.

The "Apply on {ATS}" CTA renders in the static HTML so it works without
JS. The save / apply / ignore toggles hydrate via the `RoleActions`
island.

## Data flow

`getStaticPaths()` reads every job from the build-time SQLite via
`openSiteDb()` + `selectAllJobsForStatic(db)`, deduplicates by
`shortIdFromJobId` (defensive against the 64-bit collision corner), and
returns one `{ params, props }` entry per role. `manifest.total_rows` and
`manifest.built_at` are passed through as separate props so the page
template never re-opens the SQLite.

## JSON-LD JobPosting

Emitted inline in the static HTML via
`<script type="application/ld+json" set:html={jsonLdSafe(...)}>`.
`jsonLdSafe` escapes `<`, `>`, `&`, U+2028, U+2029 to `\uXXXX` form so
remote-controlled job-description data cannot break out of the script
context (`</script>` injection is the canonical concern; this mitigation
is the standard inline-structured-data hardening).

Fields emitted:

| Field | Source | Notes |
|---|---|---|
| `@context` | constant `https://schema.org` | required |
| `@type` | constant `JobPosting` | required |
| `title` | `role.title` | required |
| `description` | `role.description_excerpt` | **omitted entirely when missing** — Google for Jobs flags description-less postings, so don't emit a degraded JobPosting at all |
| `datePosted` | `role.posted_at` ?? `role.first_seen_at` | required |
| `validThrough` | `datePosted + 90 days` | omitted when `Date.parse(datePosted)` is NaN — the field is optional and honesty beats lying |
| `hiringOrganization` | `{ "@type": "Organization", name: role.company }` | required |
| `url` | `role.url` (the ATS canonical) | required |
| `jobLocationType` | `"TELECOMMUTE"` | only when `role.workplace_type === "remote"` |
| `applicantLocationRequirements` | `{ "@type": "Country", name: role.location_country }` | only on remote roles with a country |
| `jobLocation` | `{ "@type": "Place", address: PostalAddress }` | when any location field is set |
| `baseSalary` | `MonetaryAmount` with min/max from `compensation_*` | when any compensation field is set |

`directApply` and `industry` are intentionally omitted (the former is
ambiguous when we link out; the latter is a category mismatch with our
`department` field).

## Stale role handling

Roles with `is_stale === true` (carry-forward from the previous build —
see `specs/role-lifecycle.md`) render with a small banner above the
description: "This role was carried forward from a previous build —
its source ATS may have stopped serving it." The banner is a plain
`<p>` (no `role="status"` — the fact is static, not a transient
update). The page is otherwise unchanged and remains fully indexable.

When a role drops from the SQLite entirely, no static page is emitted on
the next build. The themed `404.astro` page returns a real HTTP 404 with
brand chrome plus links back to the index and the all-jobs RSS feed.

## Save / Apply / Ignore

Re-uses `site/src/lib/storage.ts` without modification. The
`RoleActions` island reads the SavedJobs / AppliedJobs / IgnoredJobs
arrays on mount and toggles via the existing helpers. The button labels
flip in place (`☆ Save` ↔ `★ Saved`, etc.) and `aria-pressed` reflects
the underlying state for assistive tech.

## SEO posture

- `<link rel="canonical">` points at the openroles page (BaseLayout
  default — self-canonical). The JSON-LD `url` field points at the ATS
  posting, which is the conventional way to convey "the source lives
  there" without ceding canonical to the ATS.
- `<meta name="robots" content="index, follow">` is the BaseLayout
  default; no `noIndex` override on the role page.
- Sitemap entries for `/role/<short_id>/` are emitted by
  `@astrojs/sitemap` since each route is a real prerendered file.

## Performance

| Cost | Range |
|---|---|
| Build time per role | ~3–8 ms |
| Total build cost at 50k roles | ~5–10 min added |
| Tarball size delta | ~150 MB at 50k roles (5 KB / page gzipped) |
| Pages bandwidth | governed by visitor count, not page count |

The build path uses a single `openSiteDb()` open (in `getStaticPaths`)
and a single manifest read (passed through props), so the per-page
template runs constant work.

## Tests

Unit (TDD, ≥ 95% line / 90% branch per CLAUDE.md):

- `role-detail-sql.test.ts` — `shortIdFromJobId` invariants;
  `isShortId` validation; `buildRoleByShortIdQuery` (preserved for
  potential future client-side use).
- `db.test.ts` — `selectAllJobsForStatic` returns full row set, no
  LIMIT, ordered correctly, includes the `is_stale` column.
- `json-ld.test.ts` — `jsonLdSafe` escapes `<`, `>`, `&`, U+2028, U+2029
  while round-tripping back to the original via `JSON.parse`.

E2E (Playwright):

- `/role/{short_id}/` renders title, company, description, apply CTA
  with correct `href`, `target="_blank"`, `rel="noopener"`.
- The static HTML contains a JSON-LD `JobPosting` block.
- Save button toggles `aria-pressed` and persists to `localStorage`.
- `/role/{unknown-short-id}/` returns the themed 404.
- `/{any-unknown-path}` returns the themed 404.
- axe-core WCAG 2.1 AA on both the role page and the 404.

## Failure modes

- **Role missing description** — JSON-LD JobPosting is omitted entirely;
  the page renders with a "no description available" notice and the
  apply link still works.
- **Role missing posted_at** — UI falls back to `first_seen_at` ("First
  seen X days ago"); JSON-LD `datePosted` uses `first_seen_at` too.
- **Stale role** — banner renders; page otherwise unchanged.
- **Build with no SQLite** — `getStaticPaths` returns `[]`; only the
  index, 404, and feed pages emit. The fixture e2e seeds a SQLite first.
- **Page count exceeds Astro/Vite memory** — projected at >500k roles,
  out of scope today; revisit if it crosses 100k.
