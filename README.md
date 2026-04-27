# openroles

Static, queryable job board aggregator. Scrapes major Applicant Tracking Systems, ships a SQLite database to GitHub Pages, and lets you filter live job listings client-side via real SQL — no backend, no accounts, no email.

## Features

- **Multi-ATS coverage** — six major ATSes harvested via their public APIs and sitemaps
- **Real SQL in your browser** — SQLite served over HTTP range requests via `sql.js-httpvfs`
- **Mobile-first UI** — same experience on a phone and a laptop
- **RSS subscriptions** — bookmark any filter as an RSS URL; no accounts required
- **Static-only** — fully served from GitHub Pages, no servers, no databases
- **Daily refresh** — nightly GitHub Action keeps the dataset live
- **Clean-room data** — tenant lists harvested independently from Common Crawl

## Quick start

```sh
bun install
bun run scrape          # build a local SQLite from a small tenant set
bun run dev             # start the local dev server
bun run test            # full test suite, 95% line / 90% branch coverage gate
```

## Project layout

```
scraper/    Bun + TypeScript scraper, build-db, harvest CLI
site/       Astro 6 site, mobile-first, with one Svelte filter island
shared/     Shared types and zod schemas
docs/adr/   Architecture Decision Records
specs/      Feature contracts
```

## Documentation

- [Architecture](ARCHITECTURE.md) — high-level system shape
- [Contributing](CONTRIBUTING.md) — TDD discipline, conventional commits, pre-commit hooks
- [Security](SECURITY.md) — vulnerability disclosure
- [ADRs](docs/adr/) — locked architectural decisions
- [Specs](specs/) — per-feature behavior contracts

## License

- Code: [MIT](LICENSE)
- Data: [CC BY-SA 4.0](LICENSE-DATA)

Copyright © 2026 datascry.
