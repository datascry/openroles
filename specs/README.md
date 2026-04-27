# Specs

Per-feature behavior contracts. Specs describe **what** a feature does — input shapes, output shapes, edge cases, error handling, invariants — independent of how it is implemented. Code may change; the spec is what reviewers and tests measure against.

A new feature lands in three steps:

1. Write or update the relevant spec here.
2. If the feature requires a new architectural decision, add an [ADR](../docs/adr/).
3. Implement the spec, test-first.

## Index

| Spec | Scope |
|---|---|
| [data-schema.md](data-schema.md) | The on-disk schema: `Job`, `Tenant`, `Manifest`, the SQLite tables, the FTS5 layout, the indexes |
| [scraper-contract.md](scraper-contract.md) | Per-ATS scraper guarantees: input, output, retry policy, rate-limit etiquette, robots.txt handling |
| [filter-ui.md](filter-ui.md) | Filter UI behavior: query language, URL state encoding, localStorage contract, mobile + desktop presentations |
| [rss-feeds.md](rss-feeds.md) | RSS feed format: per-feed shape, item structure, build-time vs on-demand rendering |
| [classifier-contract.md](classifier-contract.md) | Level + recruiter classifier contracts (added in Phase 3) |

## Spec hygiene

- Lead with the **invariants** — what is true regardless of how the code is structured.
- Include **canonical examples** — at least one realistic input + expected output per spec.
- Include **rejection cases** — what the spec explicitly disallows or rejects.
- When the spec changes, update the version line at the top of the file and add a CHANGELOG entry under the implementing PR.
