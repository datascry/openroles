# ADR-0001: Bun as the only runtime

## Status

Accepted

## Context

This project has three workloads — a CLI scraper, a static-site generator, and a test runner — that traditionally span multiple JavaScript toolchains (Node + npm/pnpm + tsx + vitest). We want a single runtime to install, version, and reason about across local dev, CI, and contributor onboarding.

## Decision

Bun 1.3.x is the only JavaScript runtime, package manager, and test runner used by the project. Pinned in `.tool-versions` and the `package.json` `engines` field.

Concretely:

- `bun install` is the package manager — no `npm`, no `pnpm`, no `yarn` invocations anywhere in the repo.
- `bun test` is the test runner — vitest-compatible API; no separate vitest config.
- `bun:sqlite` is the build-time SQLite client for emitting `data/jobs.{sha}.sqlite`.
- TypeScript files run directly via Bun's loader — no compile step in dev.
- `Bun.gzip` / `Bun.gunzip` for compression on the build path.
- Workspaces declared in the root `package.json`.

CI runs Bun via `oven-sh/setup-bun@v2` pinned to the `.tool-versions` value.

## Consequences

### Positive

- Single toolchain: `bun install && bun test && bun run build` is the entire developer story.
- Fast cold start: ~3× faster than Node for short-lived CLI invocations, meaningful in nightly cron.
- `bun:sqlite` is the fastest in-process SQLite client available in JavaScript today; the build-db step benefits directly.
- Native TypeScript loading removes the `tsx`/`tsc` shim from dev.
- Built-in primitives (`Bun.gzip`, native `fetch`, `HTMLRewriter`) reduce the dependency surface.

### Neutral

- Some Astro-ecosystem plugins are validated against Node first; we accept the small risk of upstream incompatibility and pin Bun versions defensively.

### Negative

- Smaller community than Node — fewer Stack Overflow answers, fewer "I hit this exact bug" blog posts.
- Edge-case dependencies with native postinstall scripts may need `--ignore-scripts` workarounds.
- Anti-bot tooling that requires a real Firefox driver may not be Bun-tested; we accept a possible Node sidecar fallback for that single concern (deferred to a later phase).

## Alternatives considered

- **Node 22 + pnpm + tsx + vitest** — proven and stable, but four tools to install, configure, and version where one would do. Loses the `bun:sqlite` performance advantage.
- **Node 22 + Bun for the SQLite build only** — hybrid runtime in CI, two toolchains in dev. Adds complexity for a small performance gain.
- **Deno** — solid runtime, but the npm ecosystem story is still rougher than Bun's, and we will lean heavily on npm packages (Astro, Svelte, Playwright, etc.).
