# CLAUDE.md

Project-local context for Claude Code sessions working on this repository. Read this first.

## What this project is

`openroles` is a static, queryable job board aggregator. It scrapes major Applicant Tracking Systems via their public APIs, builds a SQLite database, ships that database to GitHub Pages, and serves a mobile-first frontend that queries the data client-side via `sql.js-httpvfs` over HTTP range requests. No backend, no accounts, no email.

Daily refresh via GitHub Action. RSS feeds are the canonical subscription model.

## Stack

- **Runtime**: Bun 1.3.x (single runtime — no Node, no pnpm/npm)
- **Language**: TypeScript strict mode (`"strict": true`, `"noUncheckedIndexedAccess": true`)
- **Workspace**: bun workspaces — packages: `scraper/`, `site/`, `shared/`
- **Frontend**: Astro 6 + one Svelte 5 island (`FilterTable.svelte`), mobile-first
- **CSS**: Open Props design tokens + custom mobile-first CSS
- **Data**: SQLite via `bun:sqlite` (build-time) → `sql.js-httpvfs` (runtime). Parquet side artifact via DuckDB CLI.
- **Lint + format**: Biome 2.x (single tool)
- **Tests**: `bun test` (vitest-compatible API), `fast-check` for properties, MSW for HTTP mocking, Playwright for e2e + a11y
- **Pre-commit**: lefthook (Go binary)
- **Commits**: Conventional Commits (commitlint enforced)

## Hard rules (do not violate)

### Code hygiene

- Write descriptions in vacuum, as if every decision were original. No "ported from", "inspired by", or "based on" language anywhere.
- Self-attribution to the project owner is appropriate in `LICENSE`, `package.json` `author`, and the README copyright. Use the configured project identity, not your personal name.
- Git config is repo-local only — never run `git config --global` from this working tree. The repo is configured with a single project identity via `git config --local`; check `.git/config` for the values and do not override them.

### TDD discipline

- **Red → Green → Refactor** cycle for every change. Tests written before implementation.
- **Per-file coverage**: line ≥ 95%, function ≥ 95%, branch ≥ 90%. A single file dropping below threshold fails CI.
- **Property tests** (fast-check) for any function with invariants — parsers, classifiers, schema validators.
- **Fixture-replay** for ATS scrapers: record real responses once via MSW, replay deterministically. Re-record quarterly.
- **Untestable code** is documented with `/* c8 ignore next */` and a one-line reason. PR review rejects unjustified ignores.

### Phase audit gate

After every implementation phase, run a **fresh Opus 4.7 subagent** (Agent tool, `subagent_type: general-purpose`, `model: opus`) for adversarial review. The gate is non-negotiable — even if the code looks clean, a second pair of eyes is required. The reviewer checks: quality, testing completeness, correctness, security, accessibility (UI phases), performance, documentation, completeness vs phase plan. Critical and Major findings remediate before the next phase begins.

### Conventional Commits

- Format: `type(scope): summary` — types: `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`, `ci`, `build`, `perf`, `revert`.
- Subject ≤ 72 chars, imperative mood, no trailing period.
- Body explains the *why*, not the what.
- No `Co-Authored-By` trailers pointing to external collaborators or AI assistants. Commits are authored by the project identity only.
- `commitlint` runs in pre-commit and CI.

## Where things are

- `docs/adr/` — locked architectural decisions (Madr 4.0 format)
- `specs/` — per-feature behavior contracts; new features need a spec before code
- `cliff.toml` — git-cliff config; CHANGELOG.md is generated, not hand-edited
- `lefthook.yml` — pre-commit hook config
- `biome.json` / `tsconfig.json` / `bunfig.toml` — tool configs
- `.github/workflows/` — CI pipelines

## Common commands

```sh
bun install              # install deps across workspaces
bun run lint             # Biome check (lint + format)
bun run typecheck        # tsc --noEmit
bun test                 # full test suite with coverage
bun run scrape           # run the scraper CLI locally
bun run build-db         # emit data/jobs.{sha}.sqlite
bun run dev              # boot the Astro dev server
bun run build            # build the static site
bun run e2e              # Playwright e2e + a11y
bun run changelog        # regenerate CHANGELOG.md from conventional commits
```

## Phase plan

The implementation roadmap lives in `docs/adr/0010-phase-plan.md`. Current phase status is tracked in `CHANGELOG.md` `[Unreleased]` section.

## When in doubt

- Read the relevant ADR before changing an architectural decision; if the ADR no longer reflects the right call, write a new ADR that supersedes it rather than silently changing course.
- Read the relevant spec before adding to a feature; new features need a spec written first.
