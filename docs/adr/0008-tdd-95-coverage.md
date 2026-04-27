# ADR-0008: TDD with per-file 95% line / 90% branch coverage gate

## Status

Accepted

## Context

This codebase has high regression risk. ATS APIs change shape without notice; classifiers misfire on edge-case titles; static-site builds can break in subtle ways that only surface days later in production. We need a discipline that keeps us honest.

A coverage threshold alone is gameable (assertion-free tests that touch lines). A no-coverage discipline lets bugs accumulate. The combination of test-first development plus an enforced per-file coverage threshold is what catches regressions while keeping authors honest about what they wrote.

## Decision

Strict **Test-Driven Development**, enforced by a per-file coverage gate in CI.

### Workflow

For every change:

1. **Red** — write a failing test in `*.test.ts` colocated with the source. Run `bun test path/to/file.test.ts`; confirm it fails for the expected reason.
2. **Green** — write the minimum code to pass.
3. **Refactor** — improve names, extract helpers. Tests still pass.
4. **Coverage** — run `bun test --coverage`. Confirm the touched files clear the per-file thresholds.
5. **Property check** — if the function has invariants, add a `fast-check` property to `tests/property/`.

### Thresholds

Configured in `bunfig.toml`:

- **Line coverage**: ≥ 95% per file
- **Function coverage**: ≥ 95% per file
- **Branch coverage**: ≥ 90% per file

A single file dropping below threshold fails CI. The gate is per-file, not aggregate, because aggregate averages let one well-covered module bail out one badly-covered one.

### Test layers

| Layer | Tool | Where |
|---|---|---|
| Unit | `bun test` | `*.test.ts` next to source |
| Property | `bun test` + `fast-check` | `tests/property/*.test.ts` |
| Fixture replay | `bun test` + `msw` | `tests/fixtures/` |
| Integration | `bun test` | `tests/integration/` |
| Component | `bun test` + `@testing-library/svelte` | next to `*.svelte` |
| E2E | `@playwright/test` | `site/tests/e2e/` |
| Visual | `@playwright/test` snapshots | `site/tests/visual/` |
| A11y | `@axe-core/playwright` | within e2e suite |

### Mutation testing

Stryker runs **weekly**, not per-PR (mutation testing is too slow for the PR critical path). Target: ≥ 80% mutation score on `scraper/src/classify/` and `scraper/src/ats/` — the logic-heavy modules where false confidence in test quality hurts most. Mutation testing supplements coverage; it catches assertion-free tests and shallow assertions.

### Coverage exemptions

Untestable code (genuine race conditions, hardware faults, unreachable defaults) is documented inline:

```typescript
/* c8 ignore next 2 — defensive: WASM init can throw on browsers we already redirect */
if (!('WebAssembly' in globalThis)) {
  redirectToFallback();
}
```

PR review rejects unjustified ignores. The `c8` annotation is honored by `bun test --coverage`.

### Fixture-replay discipline

ATS scrapers test against recorded responses, not hand-written JSON:

1. Capture a real ATS response once via MSW recorder; save to `tests/fixtures/{ats}.{tenant}.json`.
2. The test loads the fixture and asserts parser output via `toMatchSnapshot()`.
3. **Fixtures are re-recorded quarterly** via `bun test:fixtures:refresh` — runs scraper, overwrites fixtures, opens a PR with the diff. Catches breaking ATS schema changes.
4. **Three fixtures per ATS**, varied: large company (~100 jobs), small (~5 jobs), edge case (closed reqs, weird locations).

## Consequences

### Positive

- High confidence on refactors. The gate catches regressions before they merge.
- The fixture-replay discipline catches upstream ATS schema breakage on the first re-record cycle.
- New contributors learn the codebase by writing tests; the test suite becomes documentation.
- Property tests catch off-by-one and invariant violations that example-based tests miss.

### Neutral

- TDD imposes a small upfront cost per change, recouped on the first regression that the test suite catches.
- The 95% threshold is high but achievable on a codebase deliberately structured around testable units (pure parsers, pure classifiers, pure schema builders).

### Negative

- Some legitimately hard-to-test surfaces (DOM event timing, WASM initialization) need `c8 ignore` annotations. We accept the discipline of justifying each one in PR review.
- Mutation testing takes hours; we run it weekly to keep the PR pipeline fast.
- E2E test runs are the slowest layer (~3–5 minutes); we accept this in exchange for the regression catches.

## Alternatives considered

- **No coverage gate; just code review** — coverage discipline drifts under deadline pressure; an enforced gate keeps the floor.
- **Aggregate 80% coverage threshold** — gameable; one well-tested module masks several poorly-tested ones.
- **Coverage gate without TDD** — invites coverage-padding without behavior-driven tests. The TDD discipline is what produces meaningful tests.
- **Coverage at 100%** — diminishing returns past 95%, and hard-to-test surfaces become disproportionately expensive.
