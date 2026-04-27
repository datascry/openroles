# ADR-0005: Static-only deployment, no backend

## Status

Accepted

## Context

A backend-bearing architecture (an API server, a database, an auth layer) imposes ongoing cost — hosting bills, monitoring, security patching, capacity planning, downtime recovery, key rotation. For a project that publishes pre-aggregated public data, none of that complexity earns its keep.

GitHub Pages provides free static hosting with HTTPS, custom domains, and `Range`-request support. Combined with `sql.js-httpvfs` (see ADR-0002) we can serve a real database to clients without running one ourselves.

## Decision

The product is **fully static** and deployed to GitHub Pages. There is no backend in the production architecture. Specifically:

- No API server. No serverless functions on the critical path.
- No database server — the database is a SQLite file served as a static asset.
- No accounts, no authentication, no session storage.
- No analytics that round-trip user data — if usage telemetry is added later, it must be self-hosted on Pages and pseudonymous.
- No build-time secrets reach the client. Build secrets (e.g., GitHub Actions tokens) stay in Actions only.
- All client state lives in `localStorage` (for saved/applied/ignored selections) and the URL query string (for filter, sort, page).

Build pipeline:

1. Nightly GitHub Action runs the scraper, builds `data/jobs.{sha}.sqlite`, and runs the Astro build.
2. The build artifact is uploaded via `actions/upload-pages-artifact@v3`.
3. `actions/deploy-pages@v4` deploys directly from the artifact. **No commits to `main`** for build outputs — the git history stays clean.
4. A weekly tagged GitHub Release attaches the `.sqlite` and `.parquet` files for downstream consumers.

Subscriptions are handled via RSS (see ADR-0009) — no email pipeline, no newsletter database.

## Consequences

### Positive

- Zero hosting cost.
- Zero attack surface beyond static files. No SQL injection, no SSRF, no auth bypass to worry about.
- Deploys are atomic and instantly reversible — roll back by pointing Pages at a previous artifact.
- The site works offline once cached.
- Contributors can run the entire stack locally with `bun run dev` and a one-time `bun run scrape`.

### Neutral

- Some features that traditionally need a backend (job alert emails, user accounts, custom dashboards) are intentionally out of scope. Where possible we substitute static-friendly alternatives (RSS for alerts).
- A separate worker-based product surface may be added later for arbitrary-filter RSS feeds; that worker reads the same public SQLite over HTTP and is purely additive.

### Negative

- No server-side compute means no real-time data — the freshest information is from the last nightly build.
- Personalization is limited to client-side state (localStorage); we cannot sync across devices without sacrificing the static-only commitment.
- The browser does the work — `sql.js-httpvfs` runtime and SQL execution costs accrue on the client.

## Alternatives considered

- **Cloudflare Workers + Workers KV / D1** — generous free tier, but introduces deployment artifacts, secret management, and cold-start latency. Reserved for purely additive features (e.g., on-demand RSS rendering) where it earns its keep.
- **Vercel / Netlify with serverless functions** — pulls us into a build-system ecosystem we don't otherwise need; same complexity argument.
- **Self-hosted lightweight backend** — ongoing operational cost, custodial responsibility for user data, weekend pages. No.
