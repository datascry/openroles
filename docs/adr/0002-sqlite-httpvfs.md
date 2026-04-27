# ADR-0002: SQLite served over HTTP range requests via sql.js-httpvfs

## Status

Accepted

## Context

The dataset is in the low hundreds of thousands of rows — large enough that loading the whole thing as JSON on first paint is wasteful, small enough that we don't need a real database server. The user-facing query shape is filter + sort + paginate ("show me senior engineering jobs at greenhouse-hosted companies, posted in the last 7 days, remote-friendly"), which is exactly what SQL was designed for.

We are static-only on GitHub Pages, so any data layer must work without a backend. Two paths satisfy that constraint: gzipped JSON chunks loaded into memory, or a database file served over HTTP range requests.

## Decision

The on-disk data format is a single SQLite database. The browser loads it via `sql.js-httpvfs`, which uses HTTP `Range` requests to fetch only the b-tree pages needed for the current query. The runtime overhead is approximately 650 KB of `sql.js` WASM plus the b-tree pages a query touches (typically ~2 MB for a filtered listing query).

Build-time tuning, all done by `scraper/src/db/build-db.ts`:

- `pragma page_size = 1024;` then `VACUUM;` — matches the `requestChunkSize` in the client config so a fetch corresponds to a single page.
- FTS5 virtual table indexed on the title column, with `INSERT INTO fts(fts) VALUES('optimize');` as the final step to reduce post-deploy seeks.
- Covering indexes for every WHERE / ORDER BY shape the client uses: `(ats, posted_at)`, `(level, ats)`, `(workplace_type)`. Random page reads under range-VFS are roughly 100× slower than sequential, so missing indexes are not optional.

Cache-busting: the deployed file is content-hashed (`jobs.{git_short_sha}.sqlite.gz`) and served with `Cache-Control: public, max-age=31536000, immutable`. The site's `index.html` is the only short-TTL artifact and points at the current hash.

A Parquet snapshot is emitted alongside the SQLite as a side artifact via the DuckDB CLI for analytics consumers; it is not on the runtime path.

## Consequences

### Positive

- Real SQL in the browser. Filter UX gets full SQL expressiveness without an API to maintain.
- Lazy loading: the user only pays bandwidth for the pages their queries touch.
- Offline-friendly: once the b-tree pages are cached, the site keeps working with no network.
- One canonical artifact: the same `.sqlite` file is the data layer at runtime, the analytics export, and the source for the GitHub Release attachment.

### Neutral

- Build-time is bound by `bun:sqlite`'s insert speed (very fast); we accept a one-time cost per nightly build.
- The browser's RAM footprint grows as more pages are accessed — there is no LRU eviction in `sql.js`. We document this in `specs/filter-ui.md`.

### Negative

- ~650 KB WASM runtime is ~5× the Astro+Svelte runtime. Acceptable but visible in the first-paint budget.
- ~2% of browsers don't support WebAssembly. We ship a fallback page (`/no-wasm.html`) linking the GitHub Release for raw SQLite/CSV downloads.
- The host (GitHub Pages) must support `Range` requests with `206 Partial Content`. We verify this in the CI smoke test.

## Alternatives considered

- **Gzipped JSON chunks loaded by a Web Worker** — the chunk pattern works for read-only browsing but loses real SQL: every filter is reimplemented in JavaScript, FTS becomes a hand-rolled inverted index, and the client downloads more bytes than it queries.
- **Parquet + DuckDB-WASM** — DuckDB's runtime is ~10 MB versus sql.js's ~650 KB; columnar storage shines on aggregations but is overkill for our transactional filter shape. Reconsidered if a future analytics surface justifies the runtime weight.
- **No client-side query layer; pre-render every plausible filter combination** — combinatorial explosion (six ATSes × dozens of levels × thousands of titles) makes this untenable.
