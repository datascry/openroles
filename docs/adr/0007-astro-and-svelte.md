# ADR-0007: Astro + a single Svelte island

## Status

Accepted

## Context

The site is mostly read-only static content (per-tenant landing pages, RSS feeds, an About page) with one concentrated zone of interactivity: the filterable job table. Loading a full client-side application framework for read-only pages is wasteful — it ships JS that does nothing.

We want HTML-by-default with selective hydration only where interactivity earns its keep.

## Decision

The frontend uses **Astro 6** as the static-site generator and **Svelte 5** as the framework for the single hydrated island.

Astro responsibilities:

- Page routing (`index.astro`, `about.astro`, `[ats]/[slug].astro`).
- Per-tenant page generation via `getStaticPaths`, reading `bun:sqlite` at build time.
- RSS endpoints under `src/pages/feed/` (`.xml.ts` files emitted as static assets).
- `Base.astro` layout with JSON-LD `JobPosting` structured data, OG tags, viewport meta, `theme-color`.
- Tag handling, sitemap generation, robots.txt.

Svelte responsibilities:

- `FilterTable.svelte` — the one hydrated island. Debounced query, URL-state sync, localStorage saved/applied/ignored, dual-presentation cards/table.
- `FilterDrawer.svelte` — bottom-sheet on mobile, sidebar on desktop.
- `JobRow.svelte` — row presentation, accessible by keyboard and screen reader.

Astro is configured with `@astrojs/svelte` and `output: 'static'`. Hydration directive: `client:idle` for the filter island so it doesn't block initial paint.

## Consequences

### Positive

- The bulk of the site ships zero JavaScript. RSS feeds work without WASM. Per-tenant pages render on the server; SEO crawlers see real HTML.
- Svelte 5's runes-based reactivity keeps the filter UI's state model small and explicit.
- The hydration cost is concentrated to one component; the rest of the page is free.
- `getStaticPaths` against the build-time SQLite gives us per-tenant landing pages essentially for free — every tenant gets a real URL.

### Neutral

- Two frameworks (Astro for pages, Svelte for the island). Mental model is small enough that this is a feature, not a tax.
- `client:idle` defers hydration until the main thread is idle; first interaction may have a brief delay on slow devices. We accept this for the perf budget win.

### Negative

- Some Astro plugins are validated against Node first; we pin Bun and Astro versions defensively.
- The Svelte runes API is recent enough that some community examples target the older store-based reactivity. We document the runes-only convention in `specs/filter-ui.md`.

## Alternatives considered

- **SvelteKit (adapter-static)** — single framework, smallest hydration cost. Loses Astro's "ship zero JS by default" advantage; every page hydrates even if it has no interactivity.
- **Next.js with `output: 'export'`** — works but pulls in React's bundle weight and React Server Components mental model; overkill for a static site with one interactive widget.
- **Vanilla HTML + ES modules** — zero build step, but the filter UI gets crusty without a component model and per-tenant page generation becomes a script we maintain.
- **Eleventy + Alpine.js** — template-first, great for content sites; Alpine is too constrained for the filter table's complexity.
- **Astro + React island** — interchangeable choice; we picked Svelte for runtime weight (Svelte runtime is roughly half React's at our use level) and for the runes ergonomics.
