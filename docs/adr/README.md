# Architecture Decision Records

This directory captures the architectural decisions that shape this project.
Each ADR is a short document recording a decision, its context, and its
consequences. ADRs are append-only — to change a decision, write a new ADR
that supersedes the existing one rather than editing history.

The format used here is [Madr 4.0](https://adr.github.io/madr/).

## Index

| #    | Title                                              | Status   |
|------|----------------------------------------------------|----------|
| 0001 | [Bun runtime](0001-bun-runtime.md)                 | Accepted |
| 0002 | [SQLite via sql.js-httpvfs](0002-sqlite-httpvfs.md) | Accepted |
| 0003 | [Clean-room Common Crawl harvest](0003-clean-room-harvest.md) | Accepted |
| 0004 | [Mobile-first frontend](0004-mobile-first-frontend.md) | Accepted |
| 0005 | [Static-only deployment](0005-static-only.md)      | Accepted |
| 0006 | [MIT + CC BY-SA dual licensing](0006-mit-and-cc-by-sa.md) | Accepted |
| 0007 | [Astro + Svelte islands](0007-astro-and-svelte.md) | Accepted |
| 0008 | [TDD with 95% coverage](0008-tdd-95-coverage.md)   | Accepted |
| 0009 | [RSS as canonical subscription](0009-rss-as-subscription.md) | Superseded by ADR-0013 |
| 0010 | [Phase plan with audit gates](0010-phase-plan.md)  | Accepted |
| 0011 | [Incremental harvest + reprobe](0011-incremental-harvest-and-reprobe.md) | Accepted |
| 0012 | [Static-only deployment, no per-role pages](0012-static-only-deployment.md) | Accepted |
| 0013 | [Drop the RSS feeds; no subscription model](0013-no-subscription-model.md) | Accepted |

## Adding a new ADR

1. Copy `template.md` to `00NN-short-slug.md` using the next available number.
2. Fill in Status, Context, Decision, Consequences, and Alternatives considered.
3. If this ADR supersedes an existing one, update the Status of the predecessor
   to `Superseded by ADR-00NN` and link forward.
4. Update the index in this README.
5. Reference the ADR from the relevant code, spec, or architecture doc.
