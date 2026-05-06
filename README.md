# openroles

A static, privacy-respecting job-board aggregator across 24 applicant
tracking systems. No tracking. No ads. No accounts. The whole site is
HTML and JSON served from GitHub Pages; filters and saved-role state
live in your browser, never on a server.

> [!NOTE]
> Live at **https://datascry.github.io/openroles/**.
> Refreshed every night.

## What it is

`openroles` scrapes the public APIs of 24 hiring platforms, normalises
the postings into a shared schema, and emits a static dataset that
loads into a single Svelte island in the browser. There is no backend,
no database server, no analytics, no third-party scripts. Filtering,
sorting, search, and saved-role state all run client-side over a
chunked JSON index that's gzip-cached by the browser after first load.

It is, deliberately, a website that does very little — and exposes its
provenance, its build pipeline, and its dataset under permissive
licences so anyone can audit it.

## What it isn't

- A submit-once-and-pray applicant funnel. Every "Apply" link goes
  directly to the source ATS in a new tab — openroles never sees the
  click target.
- A logged-in product. There are no accounts, no email forms, no
  cookies, no first- or third-party trackers. The only client-side
  state is a small set of `localStorage` keys you populate yourself:
  saved / applied / ignored role IDs, saved searches, the active
  filter group expansion preferences, and the light/dark theme
  toggle. None of it ever leaves the browser.
- A subscription surface. RSS, email digests, and per-tag feeds were
  all explicitly retired (see [ADR-0013](docs/adr/0013-no-subscription-model.md)).
- A single-page app. The masthead, hero, and first 50 role rows are
  pre-rendered HTML so first paint never depends on JavaScript.

## How it works

```
Common Crawl  ──►  weekly-harvest.yml  ──►  data/tenants/{ats}.json
                                                    │
                                                    ▼
ATS public APIs ──►  scrape.yml (nightly)  ──►  data/scrape-outputs/*
                                                    │
                                                    ▼
                              build-deploy.yml  ──►  jobs.{sha}.sqlite (build-time)
                                                    │
                                                    ▼
                              slim-index emitter  ──►  data/slim/*.json.gz
                                                    │
                                                    ▼
                              Astro static build  ──►  GitHub Pages
                                                    │
                                                    ▼
                                                 Browser
                                            (Web Worker decodes
                                             slim-index chunks,
                                             FilterTable runs
                                             everything in memory)
```

The build-time SQLite is scaffolding only — it isn't deployed. What
ships to the browser is 38 content-hashed JSON.gz chunks plus a
`manifest.json`. Filters, sort, search, and pagination are all in-memory
operations on the merged row array; nothing roundtrips to the network
once the chunks have loaded.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full system shape and
[ADR-0012](docs/adr/0012-static-only-deployment.md) for the rationale
behind ditching the in-browser SQL engine the previous design used.

## Coverage

Twenty-four ATSes, weighted by tenant volume in the public Common
Crawl index:

```
Greenhouse · Lever · Ashby · BambooHR · Workday · iCIMS · Recruitee
Breezy · Personio · Workable · Teamtailor · SmartRecruiters · CSOD
Taleo · UltiPro · Jobvite · Zoho Recruit · Talentlyft · Pinpoint HQ
ApplicantPro · ApplicantStack · Homerun · Factorial · Eightfold
```

Tenant slugs are discovered from public Common Crawl snapshots, not
copied from another aggregator. Liveness is probed weekly; hard-dead
slugs are dropped, transient failures are retained for retry. See
[ADR-0003](docs/adr/0003-clean-room-harvest.md).

## Quick start

```sh
bun install
bun run dev      # http://localhost:4321/openroles/
bun run test     # full suite, 95% line / 95% function / 90% branch
bun run e2e      # Playwright + axe-core a11y + Lighthouse
bun run build    # static site to site/dist/
```

To build the SQLite + slim-index from cached scrape outputs:

```sh
bun run build-db -- --input data/scrape-outputs \
                    --tenants data/tenants-merged.json \
                    --output-dir data --short-sha 0000000
```

## Project layout

```
scraper/    Bun + TypeScript scraper, build-db, harvest CLI, drift detector
site/       Astro 6 site, Svelte 5 filter island, slim-index runtime
shared/     Cross-workspace zod schemas + shared types
specs/      Per-feature behavior contracts
docs/adr/   Locked architectural decisions
.github/    scrape · weekly-harvest · build-deploy · pr CI workflows
```

## Documentation

| Doc | What it's for |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | High-level system shape, data flow, key commitments |
| [CONTRIBUTING.md](CONTRIBUTING.md) | TDD discipline, conventional commits, pre-commit hooks |
| [SECURITY.md](SECURITY.md) | Vulnerability disclosure |
| [docs/adr/](docs/adr/) | Locked architectural decisions (Madr 4.0) |
| [specs/](specs/) | Per-feature behavior contracts |
| [CHANGELOG.md](CHANGELOG.md) | Release log, regenerated from Conventional Commits |

## Licence

Two licences, picked deliberately ([ADR-0006](docs/adr/0006-mit-and-cc-by-sa.md)):

- **Code** — [MIT](LICENSE). Fork it, ship it, sell it; the only ask is to keep the copyright line.
- **Listings dataset** — [CC BY-SA 4.0](LICENSE-DATA). Reuse is fine; attribution + share-alike is required so derivative aggregators stay open.

Copyright © 2026 datascry.
