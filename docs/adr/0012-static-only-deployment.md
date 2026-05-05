# ADR-0012: Static-only deployment, no per-role pages, no client SQLite

## Status

Accepted, supersedes the role-detail aspects of [ADR-0002](0002-static-database-via-sqljs-httpvfs.md).

## Context

The site is a static GitHub Pages deployment. The homepage browses 750k+
roles via a chunked JSON.gz "slim index" loaded progressively into a
Web Worker (~1.3s to interactive, see `site/src/lib/slim-index-loader.ts`).

A separate per-role detail page at `/role/?id=<short_id>` ran a SQL
query against a 1.4 GB chunked SQLite over `sql.js-httpvfs`. Empirically
on production:

| metric | value |
| --- | ---: |
| Cold first-visit role-detail load | ~111 s (after expression-index + 4 KB page tuning) |
| Warm load | ~6 s |
| Deploy bandwidth | ~1.5 GB |
| Lines of code dedicated to the detail page subsystem | ~4,500 |

The minimum objective for the site is "help end users find the jobs
they want and click through to apply". The role-detail page contributes
no incremental value to that objective — every action the user takes on
that page (read excerpt, click apply, save / mark applied / ignore) is
either available on the homepage row or ends with the user leaving for
the source ATS. The cold-load latency actively detracts from the user's
experience and constrains every architectural decision in the data
layer.

## Decision

Remove the role-detail page and its data-layer dependencies. Each row
on the homepage becomes the landing surface for that role: clicking
the apply CTA opens the source ATS in a new tab. There is no second
page.

Concretely:

1. **Delete** `site/src/pages/role/index.astro`,
   `site/src/components/RoleDetail.svelte`, the four
   `site/src/lib/role-detail-*.ts` and `role-related-sql.ts` files
   plus their tests, `site/src/lib/client-db.ts`,
   `site/src/lib/manifest-runtime.ts`,
   `site/scripts/copy-sqlite-vfs.ts`, and the `sql.js-httpvfs`
   dependency.
2. **Drop** the `description_excerpt` column from the `jobs` table and
   stop scraping it from every ATS.
3. **Drop** the FTS5 virtual table and triggers from the schema.
4. **Stop shipping** the chunked SQLite. Slim-index becomes the only
   runtime data layer. Build-db retains an ephemeral in-memory SQLite
   only as scaffolding for slim-index emission.
5. **Add** `url` and `last_seen_at` to the slim-index per-row payload
   (the apply destination must be in the slim-index since SQLite is
   no longer reachable at runtime).
6. **Promote** the row's apply link to the row's primary action.

The pre-removal state is preserved at git tag and branch
`archive/v1-full-stack` (commit `af381e52ccd59c02de05fa7248748d2119704a8f`).
See [server-deployment-reference.md](../server-deployment-reference.md)
for how to revive the role-detail subsystem on top of a Postgres-backed
API in the future.

## Consequences

### Positive

- **No cold-start cliff.** Every interaction is slim-index speed
  (~1-2 s). No Fastly cache priming, no chunked-SQLite bootstrap.
- **Deploy bandwidth drops ~94%** (~1.5 GB → ~90 MB). GitHub Pages
  soft caps stop being a concern as the corpus grows.
- **One data layer.** The slim-index is the only runtime data path.
  Easier to test, easier to optimise, easier to reason about.
- **No web-worker / wasm pipeline.** No patched `lazyfile`, no
  `.png`-suffix CDN trick, no `Content-Length` workaround, no
  `serverChunkSize`/`urlSuffix` plumbing.
- **Smaller scrape surface.** Description-cleaning logic per ATS goes
  away — every parser file gets simpler.
- **Faster CI build.** No FTS5 indexing pass, no chunked-SQLite write,
  no `.png` rename step.

### Neutral

- Slim-index gains two fields (`url`, `last_seen_at`). Estimated
  +5-10% gzipped chunk size after URL prefix dedup (URLs share long
  ATS-host prefixes).
- The editorial role-detail layout, byline / pullquote / dropcap
  formatters, and freshness-tag helpers are preserved on the
  `archive/v1-full-stack` branch — they transfer to a future server
  deployment unchanged.

### Negative

- **No description preview.** Users land on the source ATS page cold.
  For Greenhouse / Lever / Ashby this is a clean experience; for
  SmartRecruiters / iCIMS / Workday the source UI is poor and we no
  longer mediate.
- **No "More from {company}" related-roles card.** Discoverable via
  filtering by company on the homepage instead.
- **No canonical openroles URL per role for sharing.** Role-detail
  pages were already `noindex`, so the SEO loss is zero; the
  share-link loss is real (people would share the source ATS URL
  directly).
- **Description-substring search is gone.** Bare-word search now
  matches title / company / location / level / workplace. In
  practice this is what users searched for anyway — title and
  company are the dominant queries — but the corner case of
  "engineer rust kubernetes" hitting a description fragment is
  no longer supported.

## Alternatives considered

- **Inline row expansion with description.** Keep the description on
  every row, render it on-click as an in-place expansion. Rejected
  because descriptions are the dominant cost of the SQLite (and most
  of the bandwidth) — keeping them anywhere on the wire costs the
  win we're trying to claim.
- **Server-side per-role render.** Run a small backend that serves
  per-role HTML on demand. Rejected as out of scope for the static
  GitHub Pages target. Documented as the upgrade path in
  `server-deployment-reference.md`.
- **Smaller per-role surface (just title + apply link inside SQLite).**
  Rejected because it still requires sql.js-httpvfs at runtime and
  does not eliminate the cold-load cliff — a 100 MB SQLite is still
  many CDN round trips to bootstrap.
- **Move description into slim-index.** Rejected because the
  excerpts are 200-2000 bytes per row × 750k rows = ~500 MB
  uncompressed, ~150 MB gzipped, dwarfing the existing slim-index
  footprint and slowing first-paint dramatically.
