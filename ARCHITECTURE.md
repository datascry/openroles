# Architecture

High-level system shape. For locked decisions and their rationale, see [`docs/adr/`](docs/adr/). For per-feature behavior contracts, see [`specs/`](specs/).

## System diagram

```
                         ┌─────────────────────────────────────────────┐
                         │             GitHub Actions (cron)           │
                         │                                             │
                         │  weekly-harvest    nightly      weekly-rel  │
                         │       │              │              │       │
                         └───────┼──────────────┼──────────────┼───────┘
                                 │              │              │
                                 ▼              ▼              ▼
       ┌────────────────────────────────────────────────────────────────┐
       │                        scraper/  (Bun)                          │
       │                                                                 │
       │   harvest/cdx ──► tenants/{ats}.json    (Common Crawl, weekly) │
       │                                                                 │
       │   ats/{greenhouse,lever,ashby,bamboohr,workday,icims}           │
       │            │                                                    │
       │            ▼                                                    │
       │   classify/{level,recruiter}                                    │
       │            │                                                    │
       │            ▼                                                    │
       │   db/build-db ──► jobs.{sha}.sqlite + .parquet + manifest.json │
       └────────────────────────────────────────────────────────────────┘
                                     │
                                     ▼
       ┌────────────────────────────────────────────────────────────────┐
       │                        site/  (Astro)                          │
       │                                                                 │
       │   Static HTML + per-tenant pages + RSS feeds (build-time)      │
       │   FilterTable.svelte (client-side, hydrated island)            │
       └────────────────────────────────────────────────────────────────┘
                                     │
                                     ▼  actions/deploy-pages
       ┌────────────────────────────────────────────────────────────────┐
       │                       GitHub Pages                              │
       │                                                                 │
       │   index.html, /[ats]/[slug]/, /feed/*.xml, /data/*.sqlite.gz   │
       └────────────────────────────────────────────────────────────────┘
                                     │
                                     ▼  HTTP range requests
                                ┌─────────┐
                                │ Browser │
                                │         │
                                │ sql.js- │
                                │ httpvfs │
                                └─────────┘
```

## Data flow

1. **Weekly harvest** — `harvest/cdx.ts` queries the Common Crawl CDX index across the last four crawl snapshots, applies per-ATS regex patterns to extract tenant slugs, dedupes, and writes `data/tenants/{ats}.json`. Liveness is probed; hard-dead tenants (404/410) are dropped, transient failures are retained for retry.

2. **Nightly scrape** — `cli.ts scrape` reads the tenant lists, fans out HTTP requests with per-ATS concurrency caps, parses the response shape per ATS, classifies level + recruiter status, and emits a normalized `Job[]`.

3. **Build DB** — `db/build-db.ts` writes the rows into `jobs.{sha}.sqlite` with an FTS5 virtual table on title and covering indexes for the planned WHERE/ORDER BY shapes. Final step: `pragma page_size=1024; VACUUM; INSERT INTO fts(fts) VALUES('optimize');`.

4. **Site build** — Astro's `getStaticPaths` reads the freshly-built SQLite at build time, pre-renders per-tenant pages and per-ATS / per-level / per-role RSS feeds, and produces a static bundle.

5. **Deploy** — `actions/upload-pages-artifact` + `actions/deploy-pages` ship the bundle. No commits to `main` for build artifacts.

6. **Runtime** — the browser loads `jobs.{sha}.sqlite.gz` over HTTP range requests via `sql.js-httpvfs`. The filter UI debounces queries against the live SQLite. URL state and `localStorage` persist filter and saved/applied/ignored selections.

## Workspace layout

- `scraper/` — Bun + TypeScript. CLI entrypoint, six ATS parsers, classifiers, harvester, DB builder, observability.
- `site/` — Astro 6. Mobile-first layout, one Svelte filter island, build-time RSS endpoints, pre-rendered tenant pages.
- `shared/` — types and zod schemas referenced by both `scraper/` and `site/`. Single source of truth for the on-disk schema.

## Key architectural commitments

These decisions are locked. To change one, write a new ADR that supersedes the existing one — do not silently change course.

- [ADR-0001](docs/adr/0001-bun-runtime.md) — Bun as the only runtime
- [ADR-0002](docs/adr/0002-sqlite-httpvfs.md) — SQLite + sql.js-httpvfs for the data layer
- [ADR-0003](docs/adr/0003-clean-room-harvest.md) — Common Crawl CDX as the tenant-list source
- [ADR-0004](docs/adr/0004-mobile-first-frontend.md) — Mobile-first frontend, day one
- [ADR-0005](docs/adr/0005-static-only.md) — Static-only deployment; no backend
- [ADR-0006](docs/adr/0006-mit-and-cc-by-sa.md) — Dual licensing posture
- [ADR-0007](docs/adr/0007-astro-and-svelte.md) — Astro + Svelte islands
- [ADR-0008](docs/adr/0008-tdd-95-coverage.md) — TDD with per-file 95% coverage gate
- [ADR-0009](docs/adr/0009-rss-as-subscription.md) — RSS as the canonical subscription model

## Quality gates

The full set of CI gates is documented in [`CONTRIBUTING.md`](CONTRIBUTING.md) and enforced in `.github/workflows/pr.yml`. Notable thresholds:

- Per-file coverage: line ≥ 95%, function ≥ 95%, branch ≥ 90%
- Bundle size: ≤ 50 KB JS, ≤ 1 MB total first paint
- Lighthouse: desktop perf ≥ 95, mobile perf ≥ 90, A11y = 100
- Accessibility: zero WCAG 2.1 AA violations on mobile and desktop viewports
- Property tests: 1000 runs per property, zero failures
- Mutation testing: weekly, ≥ 80% mutation score on `classify/` and `ats/` modules

## Phase plan

The implementation roadmap is captured as [ADR-0010](docs/adr/0010-phase-plan.md). Each phase ends with a fresh adversarial code review by an outside reviewer; Critical and Major findings remediate before the next phase begins.
