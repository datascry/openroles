<!--
Thanks for the PR. A few non-negotiables on this project:

- Tests-first (Red, Green, Refactor). Per-file coverage ≥ 95% line, ≥ 90% branch.
- Conventional Commits. Pre-commit hooks run Biome + tsc + commitlint.
- New features need a spec under specs/. New architectural decisions need a new ADR.
- No bypass of pre-commit hooks (no --no-verify).
-->

## Summary

<!-- One or two sentences. Why is this change being made? -->

## Spec / ADR

<!-- Link to the spec under specs/ that this implements (or updates).
     Link to the ADR under docs/adr/ if this PR introduces or changes an architectural decision. -->

- Spec: <!-- specs/xxx.md -->
- ADR: <!-- docs/adr/00xx-xxx.md -->

## Test plan

<!-- Bulleted list of what was tested and how. -->

- [ ] New tests added for the changed behavior
- [ ] Per-file coverage threshold met
- [ ] Property tests added for new invariants (if applicable)
- [ ] E2E updated (if user-facing)
- [ ] A11y verified on mobile + desktop viewports (if UI changed)

## Quality gates

<!-- Confirm each ran clean locally before requesting review. -->

- [ ] `bun run lint`
- [ ] `bun run typecheck`
- [ ] `bun test --coverage`
- [ ] `bun run e2e` (if UI changed)

## Notes for reviewers

<!-- Anything reviewers should pay extra attention to. Risks, deferred work, follow-ups. -->
