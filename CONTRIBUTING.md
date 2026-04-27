# Contributing

Thanks for taking the time to contribute. This project enforces a few
non-negotiable disciplines; please read them before opening a PR.

## Setup

```sh
git clone https://github.com/datascry/openroles.git
cd openroles
bun install
bunx lefthook install   # wire up pre-commit hooks
bun test                # full test suite
```

You'll need:

- [Bun](https://bun.sh) 1.3.x (pinned in `.tool-versions`)
- [lefthook](https://github.com/evilmartians/lefthook) — `brew install lefthook`
- [git-cliff](https://github.com/orhun/git-cliff) — only required if regenerating the changelog locally

## Workflow

Strict TDD — Red, Green, Refactor:

1. **Write a failing test first.** Place it next to the source file (`thing.test.ts` next to `thing.ts`). Run `bun test path/to/thing.test.ts` and confirm it fails for the expected reason.
2. **Implement minimally.** Make the test pass with the smallest change possible. Don't add features the test didn't ask for.
3. **Refactor.** Improve naming and structure with the safety net of the green test.
4. **Coverage.** Run `bun test --coverage` for the file. Per-file thresholds: line ≥ 95%, function ≥ 95%, branch ≥ 90%. CI fails on any file below threshold.
5. **Property tests.** If the function has invariants, add a `fast-check` property in `tests/property/`.
6. **Commit** with a [Conventional Commits](https://www.conventionalcommits.org/) message. Format: `type(scope): summary`.

## Commit message format

```
type(scope): summary in imperative mood, ≤ 72 chars

Optional body explaining the *why*. Wrap at 72 chars.

Refs: #issue-number   (optional)
```

Allowed types: `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`, `ci`, `build`, `perf`, `revert`.

`commitlint` runs in pre-commit and CI; non-conformant messages are rejected.

## Pre-commit hooks

The lefthook configuration runs on every commit:

- `biome-check` — lints + formats staged files
- `typecheck` — `tsc --noEmit` on the affected package
- `commitlint` — validates the commit message

Bypassing hooks (`--no-verify`) is not permitted on this project. If a hook is wrong, fix the hook.

## Spec-first for new features

Before writing implementation code for a new feature:

1. Open or update the relevant spec under `specs/`.
2. If your change makes a new architectural decision (or supersedes an existing one), open a new ADR under `docs/adr/`. Number it sequentially.
3. PR description must link the spec / ADR.

## Phase audit gate

Each implementation phase ends with a fresh adversarial code review
performed by an outside reviewer. Critical and Major findings remediate
before the next phase begins. If you're contributing during a phase,
expect your work to be re-read with hostility.

## Running quality gates locally

```sh
bun run lint            # Biome check
bun run typecheck       # tsc --noEmit
bun test                # full suite + coverage
bun run e2e             # Playwright e2e + a11y (Phase 4 onwards)
bun run lighthouse      # local Lighthouse run (Phase 4 onwards)
```

CI runs the same set on every PR.

## License of contributions

By submitting a PR, you agree that your contribution is licensed under
the terms of this repository — code under MIT (see `LICENSE`), data
under CC BY-SA 4.0 (see `LICENSE-DATA`).
