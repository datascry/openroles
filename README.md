# openroles

A static, queryable job board across **24 applicant tracking systems**. Scrapes each ATS's public API or sitemap, ships a daily-refreshed SQLite database to GitHub Pages, and lets the browser filter tens of thousands of live roles client-side over real SQL. No backend. No accounts. No email. No tracking.

## Features

- **24-ATS coverage** — Greenhouse, Lever, Ashby, BambooHR, Workday, iCIMS, Recruitee, Breezy, Personio, Workable, Teamtailor, SmartRecruiters, csod, Taleo, UltiPro, Jobvite, Zoho Recruit, Talentlyft, Pinpoint HQ, ApplicantPro, ApplicantStack, Homerun, Factorial, Eightfold.
- **Real SQL in your browser** — content-hashed SQLite served over HTTP range requests via `sql.js-httpvfs`. FTS5 over title / company / description; standard SQL across the rest.
- **Search modifiers** — `field:value` syntax for `title`, `company`, `description`, `location`. Quoted phrases. AND-joined multi-term. See [specs/filter-ui.md](specs/filter-ui.md).
- **Saved / Applied / Ignored sub-views** — single-select filter chips backed by `localStorage`; nothing leaves the browser.
- **Mobile-first UI with a brutalist visual theme** — system fonts only (no web font requests), light + dark mode with a persistent toggle, WCAG 2.1 AA contrast verified by axe-core in CI. See [specs/visual-theme.md](specs/visual-theme.md).
- **Role lifecycle** — roles whose tenant API failed today carry forward as STALE for up to 3 days before dropping, so a single upstream outage doesn't erase a company's catalogue. See [specs/role-lifecycle.md](specs/role-lifecycle.md).
- **Static-only** — fully served from GitHub Pages. The runtime data layer is a chunked slim-index (~45 MB gzipped JSON across 38 chunks) loaded progressively in a Web Worker; no SQL engine in the browser. See [ADR-0012](docs/adr/0012-static-only-deployment.md).
- **Daily refresh** — `daily-refresh.yml` GitHub Action runs at 05:17 UTC, scrapes every ATS, rebuilds the SQLite, runs a drift report, and deploys to Pages.
- **Clean-room dataset** — tenant lists harvested independently from Common Crawl by `weekly-harvest.yml`; nothing copied from another aggregator.
- **SEO baked in** — sitemap-index.xml, JSON-LD `WebSite` with `SearchAction`, Open Graph + Twitter Card, role-count-aware page title, robots.txt.

## Quick start

```sh
bun install
bun run dev             # local dev server on http://localhost:4321/openroles/
bun run test            # full test suite, 95 % line / 90 % branch coverage gate
bun run e2e             # Playwright + axe-core a11y + Lighthouse
```

To regenerate the SQLite locally from cached scrape outputs:

```sh
bun run build-db -- --input data/scrape-outputs --tenants data/tenants-merged.json \
                    --output-dir data --short-sha 0000000
```

To preview the production build under nginx with HTTP-range support:

```sh
docker build -t openroles:local .
docker run --rm -p 8080:80 openroles:local
# open http://localhost:8080/openroles/
```

## Project layout

```
scraper/    Bun + TypeScript scraper, build-db, harvest CLI, drift detector
site/       Astro 6 site, Svelte 5 filter island, slim-index runtime
shared/     Cross-workspace zod schemas + shared types
specs/      Per-feature behavior contracts (data, scraper, filter UI,
            visual theme, role lifecycle)
docs/adr/   Locked architectural decisions
.github/    daily-refresh / weekly-harvest / PR CI workflows + dependabot
```

## Documentation

- [Architecture](ARCHITECTURE.md) — high-level system shape
- [Contributing](CONTRIBUTING.md) — TDD discipline, conventional commits, pre-commit hooks
- [Security](SECURITY.md) — vulnerability disclosure
- [ADRs](docs/adr/) — locked architectural decisions
- [Specs](specs/) — per-feature behavior contracts
- [CHANGELOG](CHANGELOG.md) — Keep-a-Changelog format, regenerated from Conventional Commits via `bun run changelog`

## License

- Code: [MIT](LICENSE)
- Data: [CC BY-SA 4.0](LICENSE-DATA)

Copyright © 2026 datascry.
