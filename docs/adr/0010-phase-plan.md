# ADR-0010: Phase plan with mandatory adversarial audit gates

## Status

Accepted

## Context

The roadmap from initial scaffold to first deploy is large enough that "ship in one big push" would invite quality and security regressions. We want a phased plan with explicit checkpoints, and we want each checkpoint validated by a reader who has not been in the trenches.

Self-review is biased toward what was just written; an outside reviewer reading the code cold catches the things the author has stopped seeing. Code review is most useful when the reviewer is unfamiliar.

## Decision

The implementation is sequenced into seven phases. **Each phase ends with a mandatory adversarial code review by a fresh outside reviewer** before the next phase can begin.

### Phases

| Phase | Goal | Estimated effort |
|---|---|---|
| 1 | Foundations: workspaces, configs, hooks, CI scaffold, ADRs, specs | 1 day |
| 2 | ATS scrapers: six parsers with fixture-replay tests | 2–3 days |
| 3 | Classifiers + DB build: level/recruiter classifiers, schema migrations, FTS5 | 1 day |
| 4 | Astro site, mobile-first: filter UI, per-tenant pages, RSS feeds | 3 days |
| 5 | Common Crawl harvester: tenant-list discovery + liveness probe | 2–3 days |
| 6 | Anti-bot driver for session-locked tenants | (deferred until needed) |
| 7 | Quality + observability: drift detector, dead-tenant alerts, run reports, mutation testing | 0.5 day |
| 8 | Client-side query runtime: sql.js-httpvfs Worker, results rendering, hydration-verifying e2e | 0.5 day |

**Mutation testing in Phase 7 is deferred** — the established mutation-testing harnesses (StrykerJS) do not yet have first-class Bun support and run only against Node, requiring a parallel test harness. The unit-test suite already has property tests for every classifier and parser, schema-validation round-trips for every on-disk shape, and adversarial-audit gates per phase, which substantively cover the same defect-detection surface. We will revisit when StrykerJS adds Bun coverage natively or when a Bun-native mutator ships.

Within each phase, the rhythm is: write a failing test → implement → cover → integrate → audit gate → merge.

### Audit gate

At the end of each phase:

1. A fresh reviewer (no shared context with the phase author) is engaged.
2. The reviewer reads the code as a hostile outside party would. The reviewer's prompt includes the explicit checks below.
3. The reviewer returns a categorized issue list: Critical, Major, Minor.
4. **Critical and Major findings remediate before the next phase begins.** Minor findings are filed as tracked TODOs.
5. The phase is not "done" until the audit passes.

### Audit checks (mandatory, per phase)

- **Quality** — naming, dead code, duplicated logic, unjustified abstractions, type-safety holes.
- **Testing completeness** — per-file coverage thresholds met, missing edge cases, missing property tests, fixture realism.
- **Correctness** — off-by-one, race conditions, unhandled errors, retry storms, regex catastrophic backtracking.
- **Security** — injection (SQL, shell, regex, prototype), unbounded input, SSRF, secret leakage, dependency CVEs.
- **Accessibility** (UI phases) — WCAG 2.1 AA, ARIA, color-contrast, keyboard navigation, screen-reader semantics.
- **Performance** — N+1 queries, missing indexes, unbounded memory, blocking I/O on critical paths, bundle-size regressions.
- **Documentation** — ADRs current, specs cover new features, CHANGELOG entry for the phase, README freshness.
- **Completeness vs phase plan** — phase deliverables actually shipped, no half-finished modules, no `TODO`/`FIXME` left without ticket links.

## Consequences

### Positive

- Quality stays high throughout, not just at the start.
- Outside-reviewer audits catch what the author has stopped seeing.
- Phase boundaries are explicit checkpoints, useful for scope control and time budgeting.
- The audit transcript becomes part of the project's record; future contributors can see what was caught.

### Neutral

- Each audit costs reviewer time. We accept that as the price of the discipline.
- The phase boundaries are guidelines, not rigid; if a phase needs more or less time, we adjust the plan rather than the gate.

### Negative

- The audit gate adds a synchronization point at each phase boundary; "almost done" cannot bypass it.
- A failing audit may delay a phase by hours or days while remediation happens. We accept that delay as preferable to compounding latent issues into later phases.

## Alternatives considered

- **No phase audits, just self-review** — works for small projects; for the breadth of this codebase the bias risk is too high.
- **Audit only at the end** — defers feedback until the cost of remediation is highest. Phase audits find issues while context is still fresh.
- **PR review only** — PR reviews focus on diffs; phase audits read the whole phase output as a coherent thing. Both belong; phase audits supplement, not replace, PR review.
