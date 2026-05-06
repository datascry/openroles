# Specs

Per-feature behavior contracts. Specs describe **what** a feature does — input shapes, output shapes, edge cases, error handling, invariants — independent of how it is implemented. Code may change; the spec is what reviewers and tests measure against.

A new feature lands in three steps:

1. Write or update the relevant spec here.
2. If the feature requires a new architectural decision, add an [ADR](../docs/adr/).
3. Implement the spec, test-first.

## Index

### Active

| Spec | Scope |
|---|---|
| [data-schema.md](data-schema.md) | The on-disk schema: `Job`, `Tenant`, `Manifest`, the SQLite tables (build-time scaffolding), the FTS5 layout, the indexes |
| [scraper-contract.md](scraper-contract.md) | Per-ATS scraper guarantees: input, output, retry policy, rate-limit etiquette, robots.txt handling |
| [filter-ui.md](filter-ui.md) | Filter UI behavior: query language, URL state encoding, localStorage contract, mobile + desktop presentations |
| [role-lifecycle.md](role-lifecycle.md) | How a role enters, persists in, and leaves the catalogue: `is_stale`, the 3-day TTL, `first_seen_at` semantics, drift-detector hooks |
| [harvest-incremental.md](harvest-incremental.md) | Common Crawl tenant-list discovery + reprobe pipeline (companion to ADR-0011) |
| [observability.md](observability.md) | Drift detector, dead-tenant alerts, run reports — pure modules under `scraper/src/observability/` |
| [visual-theme.md](visual-theme.md) | Brutalist Press visual theme: tokens, type stack, palette, density, accent rules |

### Historical / superseded

| Spec | Status |
|---|---|
| [role-detail.md](role-detail.md) | Superseded by [ADR-0012](../docs/adr/0012-static-only-deployment.md) — per-role page no longer exists |
| [uplift-v2-handoff.md](uplift-v2-handoff.md) | Landed in production; partially superseded by ADR-0012 (the broadsheet role-detail surface). Preserved for design-token cross-reference |

## Spec hygiene

- Lead with the **invariants** — what is true regardless of how the code is structured.
- Include **canonical examples** — at least one realistic input + expected output per spec.
- Include **rejection cases** — what the spec explicitly disallows or rejects.
- When the spec changes, update the version line at the top of the file and add a CHANGELOG entry under the implementing PR.
