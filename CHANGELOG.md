# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This file is regenerated from [Conventional Commits](https://www.conventionalcommits.org/)
via `bun run changelog` (uses [`git-cliff`](https://github.com/orhun/git-cliff)).
Do not hand-edit; edit commit messages instead.

## [Unreleased]

### Added

- Project scaffold: bun workspaces, TypeScript strict mode, Biome lint + format, Bun test runner with coverage.
- Pre-commit hooks via lefthook: Biome check, type check, commitlint.
- CI workflow scaffold for PRs (lint, typecheck, test, dependency review, CodeQL).
- ADR template plus ten initial Architecture Decision Records covering runtime, data layer, harvest model, frontend, deployment shape, licensing, framework choices, TDD discipline, subscription model, and the phase plan.
- Spec skeleton: data schema, scraper contract, filter UI, RSS feeds.
- MIT license for code; CC BY-SA 4.0 for harvested dataset.
- Shared zod schemas for ATSId, Level, WorkplaceType, Tenant, Job, ScrapeInput/Output, and Manifest, with derived `level_rank` and stable SHA-256 `Job.id` hashing.
- HTTP client with project-identifying User-Agent, exponential backoff with jitter, `Retry-After` honoring, per-host robots.txt cache (24h TTL, fail-closed on 5xx/network), 30s timeout, no cookies.
- Six ATS scrapers — Greenhouse, Lever, Ashby, BambooHR, Workday (paginated), iCIMS (sitemap + JSON-LD walk) — each with three fixture-replay tests, a determinism property test, retry coverage, and a robots.txt block test.
- Scrape orchestrator with per-ATS p-limit concurrency, dispatch by ATS id, and a CLI `scrape` subcommand reading a `ScrapeInput` JSON file.
- Level and recruiter classifiers as pure functions over title/department text, with property tests asserting determinism and closed-set output.
- SQLite build pipeline (`bun:sqlite`): per-spec schema (jobs/tenants/crawls), seven covering indexes, and an FTS5 virtual table over title/company/description with porter+unicode61 tokenization; `page_size = 1024` matches the `sql.js-httpvfs` request chunk size, and `VACUUM` plus FTS `optimize` run as the final build step.
- CLI `build-db` subcommand reads a directory of scrape outputs, validates them through the zod schema boundary, applies classifiers, writes `jobs.{sha}.sqlite`, and emits `manifest.json` alongside.

[Unreleased]: https://github.com/datascry/openroles/compare/HEAD...HEAD
