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
       │   Static HTML shell (build-time)                               │
       │   FilterTable.svelte (client-side, hydrated island)            │
       └────────────────────────────────────────────────────────────────┘
                                     │
                                     ▼  actions/deploy-pages
       ┌────────────────────────────────────────────────────────────────┐
       │                       GitHub Pages                              │
       │                                                                 │
       │   index.html, /data/manifest.json, /data/slim/*.json.gz         │
       └────────────────────────────────────────────────────────────────┘
                                     │
                                     ▼  fetch + Web Worker decompress
                                ┌─────────┐
                                │ Browser │
                                │         │
                                │ slim-   │
                                │ index   │
                                └─────────┘
```

## Data flow

1. **Weekly harvest** — `harvest/cdx.ts` queries the Common Crawl CDX index across the last four crawl snapshots, applies per-ATS regex patterns to extract tenant slugs, dedupes, and writes `data/tenants/{ats}.json`. Liveness is probed; hard-dead tenants (404/410) are dropped, transient failures are retained for retry.

2. **Nightly scrape** — `cli.ts scrape` reads the tenant lists, fans out HTTP requests with per-ATS concurrency caps, parses the response shape per ATS, classifies level + recruiter status, and emits a normalized `Job[]`.

3. **Build DB** — `db/build-db.ts` writes the rows into an in-process `jobs.{sha}.sqlite` (build-time scaffolding only — the SQLite itself is no longer deployed) and emits the slim-index: 38 pre-gzipped JSON chunks of ~20k rows each, sorted by `posted_at DESC NULLS LAST`, content-hashed for cache safety. See [ADR-0012](docs/adr/0012-static-only-deployment.md).

4. **Site build** — Astro reads the build-time SQLite for the SSR seed rows (top-50 newest) and emits the static shell. The slim-index chunks + `manifest.json` are copied into `dist/data/`.

5. **Deploy** — `actions/upload-pages-artifact` + `actions/deploy-pages` ship the bundle. No commits to `main` for build artifacts.

6. **Runtime** — the browser fetches `manifest.json`, then a Web Worker streams the 38 slim-index chunks, `gunzip`s each, and merges them into an in-memory `SlimRow[]`. Filter / sort / search become array operations — sub-50ms after the index has loaded. URL state and `localStorage` persist filter and saved/applied/ignored selections.

## Workspace layout

- `scraper/` — Bun + TypeScript. CLI entrypoint, ATS parsers, classifiers, harvester, DB builder, slim-index emitter, observability.
- `site/` — Astro 6. Mobile-first layout, one Svelte filter island, slim-index runtime.
- `shared/` — types and zod schemas referenced by both `scraper/` and `site/`. Single source of truth for the on-disk schema.

## Key architectural commitments

These decisions are locked. To change one, write a new ADR that supersedes the existing one — do not silently change course.

- [ADR-0001](docs/adr/0001-bun-runtime.md) — Bun as the only runtime
- [ADR-0002](docs/adr/0002-sqlite-httpvfs.md) — SQLite + sql.js-httpvfs for the data layer (superseded by ADR-0012)
- [ADR-0003](docs/adr/0003-clean-room-harvest.md) — Common Crawl CDX as the tenant-list source
- [ADR-0004](docs/adr/0004-mobile-first-frontend.md) — Mobile-first frontend, day one
- [ADR-0005](docs/adr/0005-static-only.md) — Static-only deployment; no backend
- [ADR-0006](docs/adr/0006-mit-and-cc-by-sa.md) — Dual licensing posture
- [ADR-0007](docs/adr/0007-astro-and-svelte.md) — Astro + Svelte islands
- [ADR-0008](docs/adr/0008-tdd-95-coverage.md) — TDD with per-file 95% coverage gate
- [ADR-0009](docs/adr/0009-rss-as-subscription.md) — RSS as the canonical subscription model (superseded by ADR-0013)
- [ADR-0010](docs/adr/0010-phase-plan.md) — Phase plan with audit gates
- [ADR-0011](docs/adr/0011-incremental-harvest-and-reprobe.md) — Incremental harvest and re-probe
- [ADR-0012](docs/adr/0012-static-only-deployment.md) — Static-only deployment, no per-role pages, no client SQLite
- [ADR-0013](docs/adr/0013-no-subscription-model.md) — Drop the RSS feeds; no subscription model
- [ADR-0014](docs/adr/0014-filter-information-architecture.md) — Filter UI information architecture

## Quality gates

The full set of CI gates is documented in [`CONTRIBUTING.md`](CONTRIBUTING.md) and enforced in `.github/workflows/pr.yml`. Notable thresholds:

- Per-file coverage: line ≥ 95%, function ≥ 95%, branch ≥ 90%
- Bundle size budgets (gzipped, enforced by `bun run size-limit`):
  - FilterTable island: ≤ 35 KB
  - All client JS combined: ≤ 60 KB
  - Index HTML (covers inlined CSS): ≤ 30 KB
  - Global CSS: ≤ 15 KB
- Lighthouse: desktop perf ≥ 95, mobile perf ≥ 90, A11y = 100
- Accessibility: zero WCAG 2.1 AA violations on mobile and desktop viewports
- Property tests: 1000 runs per property, zero failures
- Mutation testing: weekly, ≥ 80% mutation score on `classify/` and `ats/` modules

## Phase plan

The implementation roadmap is captured as [ADR-0010](docs/adr/0010-phase-plan.md). Each phase ends with a fresh adversarial code review by an outside reviewer; Critical and Major findings remediate before the next phase begins.
