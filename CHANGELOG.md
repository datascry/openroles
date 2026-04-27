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

[Unreleased]: https://github.com/datascry/openroles/compare/HEAD...HEAD
