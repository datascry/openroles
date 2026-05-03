// Client-side slim-index loader and in-memory filter engine.
//
// Loads the chunked JSON slim index emitted by scraper/src/db/slim-index.ts,
// progressively (chunk 0 inline → remaining chunks via Web Worker, in
// the same pattern Feashliaa/job-board-aggregator validated at 1.7M
// jobs), and exposes a synchronous `filter()` over the accumulated rows.
//
// Why two loading paths:
//   - Chunk 0 on the main thread: it's the first batch the user sees.
//     We want it in-memory and rendered as fast as possible. The
//     Worker boot adds ~50 ms of overhead which matters here.
//   - Remaining chunks via a Worker: each chunk is ~14 MB raw / ~2 MB
//     gzipped. Decompressing + parsing on the main thread would block
//     the UI for ~150-700 ms per chunk on mobile CPUs. The Worker
//     does it off-thread and posts back the parsed rows.
//
// The on-wire format (see scraper/src/db/slim-index.ts ChunkRowOnWire):
//   { i, a, t, ti, c, l, w, r, s, loc, cc, p, f, cm, cmax, cur }
// kept short so JSON.parse over millions of keys stays cheap.

import type { ManifestRuntime, SlimChunkRuntime } from "./manifest-runtime.ts";

/** A row's representation in memory, as emitted by the slim-index. */
export interface SlimRow {
  /** First 16 hex chars of the canonical Job.id; uniquely identifies the row for SQLite click-through. */
  readonly short_id: string;
  readonly ats: string;
  readonly tenant_slug: string;
  readonly title: string;
  readonly company: string;
  readonly level: string | null;
  readonly workplace_type: string | null;
  readonly is_recruiter_post: boolean;
  readonly is_stale: boolean;
  readonly location_text: string | null;
  readonly location_country: string | null;
  readonly posted_at: string | null;
  readonly first_seen_at: string;
  readonly compensation_min: number | null;
  readonly compensation_max: number | null;
  readonly compensation_currency: string | null;
}

interface ChunkRowOnWire {
  i: string;
  a: string;
  t: string;
  ti: string;
  c: string;
  l: string | null;
  w: string | null;
  r: 0 | 1;
  s: 0 | 1;
  loc: string | null;
  cc: string | null;
  p: string | null;
  f: string;
  cm: number | null;
  cmax: number | null;
  cur: string | null;
}

function fromWire(r: ChunkRowOnWire): SlimRow {
  return {
    short_id: r.i,
    ats: r.a,
    tenant_slug: r.t,
    title: r.ti,
    company: r.c,
    level: r.l,
    workplace_type: r.w,
    is_recruiter_post: r.r === 1,
    is_stale: r.s === 1,
    location_text: r.loc,
    location_country: r.cc,
    posted_at: r.p,
    first_seen_at: r.f,
    compensation_min: r.cm,
    compensation_max: r.cmax,
    compensation_currency: r.cur,
  };
}

/**
 * Decompress + parse a single chunk URL. Pre-gzipped on origin, served
 * with `Content-Encoding: gzip` (or, in our case, identity .gz files —
 * we run `DecompressionStream` ourselves, see the comment in
 * scraper/src/db/slim-index.ts about Pages' on-the-fly gzip).
 *
 * GitHub Pages (Fastly) serves application/json with gzip auto-applied
 * to the response body. Browsers decompress that transparently.
 *
 * Our chunks are also pre-gzipped at build time and named *.json.gz —
 * that means Fastly doesn't re-gzip them (already-compressed extension)
 * and the browser receives the raw gzip bytes without auto-decompressing.
 * We have to run DecompressionStream ourselves.
 */
async function fetchAndDecompressChunk(url: string): Promise<SlimRow[]> {
  const res = await fetch(url, { cache: "force-cache" });
  if (!res.ok) {
    throw new Error(`fetchAndDecompressChunk: ${url} returned HTTP ${res.status}`);
  }
  // If the server sent Content-Encoding: gzip, the browser already
  // decompressed for us — body is the raw JSON text. If the file was
  // served identity (.gz file extension, Fastly-skipped), the body is
  // gzipped bytes and we run DecompressionStream.
  //
  // Detect by trying to decompress; on failure, fall back to plain
  // text. This is the same dance the reference impl uses.
  const enc = res.headers.get("content-encoding");
  let text: string;
  if (enc === null || enc === "identity") {
    // No upstream decompression — we have raw .gz bytes.
    const blob = await res.blob();
    const ds = new DecompressionStream("gzip");
    const decompressed = blob.stream().pipeThrough(ds);
    text = await new Response(decompressed).text();
  } else {
    // Upstream already decompressed via Content-Encoding negotiation.
    text = await res.text();
  }
  const onWire = JSON.parse(text) as ChunkRowOnWire[];
  return onWire.map(fromWire);
}

export interface SlimIndexLoadOptions {
  readonly basePath: string;
  readonly manifest: ManifestRuntime;
  /**
   * Called every time a chunk lands. The handler receives the rows
   * that just arrived AND the cumulative row count so far. Use this
   * to refilter / re-render after each chunk.
   */
  readonly onChunk?: (chunk: SlimRow[], cumulative: number, total: number) => void;
  /**
   * Optional rows to seed the in-memory dataset before any chunks
   * arrive — typically the rows the SSR pre-paint embedded as JSON.
   * Lets the FilterTable skip an extra render on first paint.
   */
  readonly seed?: ReadonlyArray<SlimRow>;
  /** Override fetch (for tests). Defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
}

export interface SlimIndex {
  /** All rows loaded so far, sorted by posted_at DESC NULLS LAST. */
  readonly rows: ReadonlyArray<SlimRow>;
  /** Total rows we expect once every chunk has loaded. */
  readonly totalExpected: number;
  /** True once every chunk has been fetched and merged. */
  readonly fullyLoaded: boolean;
}

/**
 * Load the slim index progressively. Returns immediately after chunk 0
 * has been fetched on the main thread; the rest stream in via
 * `onChunk` callbacks fired from a Web Worker. The returned object's
 * `rows` array is mutated in place as chunks arrive — capture
 * `rows.length` after each `onChunk` to know how much is loaded.
 *
 * If `manifest.slim_index_chunks` is empty, the loader resolves
 * immediately with an empty result. Callers should fall back to the
 * legacy SQLite path in that case.
 */
export async function loadSlimIndex(opts: SlimIndexLoadOptions): Promise<SlimIndex> {
  const base = opts.basePath.replace(/\/$/, "");
  const chunks = opts.manifest.slim_index_chunks;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const totalExpected = opts.manifest.slim_index_total_rows;

  // Mutable accumulator. Caller sees the same array reference grow as
  // chunks arrive (matches the reference impl's pattern).
  const rows: SlimRow[] = opts.seed ? [...opts.seed] : [];

  if (chunks.length === 0) {
    return { rows, totalExpected, fullyLoaded: true };
  }

  const result: { rows: SlimRow[]; totalExpected: number; fullyLoaded: boolean } = {
    rows,
    totalExpected,
    fullyLoaded: false,
  };

  // Chunk 0 inline — first paint cares.
  const firstChunk = chunks[0];
  if (firstChunk === undefined) {
    return { rows, totalExpected, fullyLoaded: true };
  }
  const firstUrl = `${base}/data/${firstChunk.file}`;
  const firstRows = await fetchAndDecompressChunkWithImpl(firstUrl, fetchImpl);
  // Avoid duplicating any rows the seed already contains.
  appendUnique(rows, firstRows);
  if (opts.onChunk) opts.onChunk(firstRows, rows.length, totalExpected);

  if (chunks.length === 1) {
    result.fullyLoaded = true;
    return result;
  }

  // Remaining chunks via a Worker — each chunk decompress + parse takes
  // 100-700 ms on mobile CPUs; off-thread keeps the UI responsive.
  await loadRestInWorker(base, chunks.slice(1), opts.onChunk, rows, totalExpected);
  result.fullyLoaded = true;
  return result;
}

async function fetchAndDecompressChunkWithImpl(
  url: string,
  fetchImpl: typeof fetch,
): Promise<SlimRow[]> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    return await fetchAndDecompressChunk(url);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function appendUnique(target: SlimRow[], incoming: ReadonlyArray<SlimRow>): void {
  if (target.length === 0) {
    target.push(...incoming);
    return;
  }
  const existing = new Set<string>(target.map((r) => r.short_id));
  for (const r of incoming) {
    if (!existing.has(r.short_id)) {
      target.push(r);
      existing.add(r.short_id);
    }
  }
}

function loadRestInWorker(
  base: string,
  remaining: ReadonlyArray<SlimChunkRuntime>,
  onChunk: SlimIndexLoadOptions["onChunk"],
  target: SlimRow[],
  totalExpected: number,
): Promise<void> {
  // Worker source is shipped as a sibling file under /sqlite-vfs/ for
  // the same reason the SQL worker is — keeps the main bundle tiny.
  // See scripts/copy-slim-worker.ts which copies this file at build.
  const workerUrl = `${base}/sqlite-vfs/slim-index-worker.js`;
  const worker = new Worker(workerUrl, { type: "module" });

  let pending = remaining.length;
  return new Promise<void>((resolve, reject) => {
    worker.onmessage = (ev: MessageEvent<{ rows: ChunkRowOnWire[]; error?: string }>) => {
      if (ev.data.error !== undefined) {
        worker.terminate();
        reject(new Error(`slim-index worker: ${ev.data.error}`));
        return;
      }
      const rows = ev.data.rows.map(fromWire);
      appendUnique(target, rows);
      if (onChunk) onChunk(rows, target.length, totalExpected);
      pending -= 1;
      if (pending === 0) {
        worker.terminate();
        resolve();
      }
    };
    worker.onerror = (ev: ErrorEvent) => {
      worker.terminate();
      reject(new Error(`slim-index worker error: ${ev.message}`));
    };
    for (const chunk of remaining) {
      worker.postMessage({ url: `${base}/data/${chunk.file}` });
    }
  });
}

/**
 * Filter predicate for the in-memory dataset. Mirrors the SQL plan
 * the legacy SQLite path produced — keeping the contract identical
 * minimises the FilterTable refactor.
 */
export interface FilterPredicate {
  readonly q?: string; // free-text, lowercased
  readonly ats?: ReadonlySet<string>;
  readonly level?: ReadonlySet<string>;
  readonly workplace_type?: ReadonlySet<string>;
  readonly country?: string;
  readonly hideRecruiter?: boolean;
  readonly hideStale?: boolean;
  readonly minComp?: number;
  readonly sinceMs?: number; // absolute epoch ms — rows with posted_at >= this pass
  readonly idAllowlist?: ReadonlySet<string>; // 16-char short_ids
}

const ESCAPE_RE = /[.*+?^${}()|[\]\\]/g;

/** Run the predicate over `rows` and return up to `limit` matching rows in input order. */
export function filterRows(
  rows: ReadonlyArray<SlimRow>,
  pred: FilterPredicate,
  offset: number,
  limit: number,
): { matches: SlimRow[]; total: number } {
  const titleRegex = pred.q ? new RegExp(escapeRegExp(pred.q), "i") : null;
  const companyRegex = titleRegex; // same query also tested against company
  const matches: SlimRow[] = [];
  let total = 0;
  for (const r of rows) {
    if (!matchesPredicate(r, pred, titleRegex, companyRegex)) continue;
    total += 1;
    if (total > offset && matches.length < limit) matches.push(r);
    // Don't break early — total count is needed for paginator.
  }
  return { matches, total };
}

function escapeRegExp(s: string): string {
  return s.replace(ESCAPE_RE, "\\$&");
}

function matchesEnum(r: SlimRow, pred: FilterPredicate): boolean {
  if (pred.idAllowlist && !pred.idAllowlist.has(r.short_id)) return false;
  if (pred.ats && !pred.ats.has(r.ats)) return false;
  if (pred.level && (r.level === null || !pred.level.has(r.level))) return false;
  if (
    pred.workplace_type &&
    (r.workplace_type === null || !pred.workplace_type.has(r.workplace_type))
  ) {
    return false;
  }
  if (pred.country !== undefined && r.location_country !== pred.country) return false;
  return true;
}

function matchesScalar(r: SlimRow, pred: FilterPredicate): boolean {
  if (pred.hideRecruiter && r.is_recruiter_post) return false;
  if (pred.hideStale && r.is_stale) return false;
  if (pred.minComp !== undefined) {
    if (r.compensation_min === null) return false;
    if (r.compensation_min < pred.minComp) return false;
  }
  if (pred.sinceMs !== undefined) {
    if (r.posted_at === null) return false;
    const t = Date.parse(r.posted_at);
    if (!Number.isFinite(t) || t < pred.sinceMs) return false;
  }
  return true;
}

function matchesText(r: SlimRow, titleRegex: RegExp | null, companyRegex: RegExp | null): boolean {
  if (titleRegex === null) return true;
  if (titleRegex.test(r.title)) return true;
  return companyRegex?.test(r.company) ?? false;
}

function matchesPredicate(
  r: SlimRow,
  pred: FilterPredicate,
  titleRegex: RegExp | null,
  companyRegex: RegExp | null,
): boolean {
  return matchesEnum(r, pred) && matchesScalar(r, pred) && matchesText(r, titleRegex, companyRegex);
}

/**
 * Sort a list of rows by the given key, in place. Mirrors the SQL
 * SORT_TO_ORDER_BY map in filter-sql.ts. NULL handling: nulls sort
 * to the end regardless of direction (matches `NULLS LAST`).
 */
export function sortRows(rows: SlimRow[], sort: SortKey): void {
  const cmp = SORT_COMPARATORS[sort];
  rows.sort(cmp);
}

export type SortKey =
  | "posted_at:desc"
  | "posted_at:asc"
  | "first_seen:desc"
  | "first_seen:asc"
  | "company:asc"
  | "company:desc";

function nullsLastDesc(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a > b ? -1 : 1;
}

function nullsLastAsc(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? -1 : 1;
}

const SORT_COMPARATORS: Record<SortKey, (a: SlimRow, b: SlimRow) => number> = {
  "posted_at:desc": (a, b) => {
    const c = nullsLastDesc(a.posted_at, b.posted_at);
    if (c !== 0) return c;
    return a.first_seen_at > b.first_seen_at ? -1 : a.first_seen_at < b.first_seen_at ? 1 : 0;
  },
  "posted_at:asc": (a, b) => {
    const c = nullsLastAsc(a.posted_at, b.posted_at);
    if (c !== 0) return c;
    return a.first_seen_at < b.first_seen_at ? -1 : a.first_seen_at > b.first_seen_at ? 1 : 0;
  },
  "first_seen:desc": (a, b) =>
    a.first_seen_at > b.first_seen_at ? -1 : a.first_seen_at < b.first_seen_at ? 1 : 0,
  "first_seen:asc": (a, b) =>
    a.first_seen_at < b.first_seen_at ? -1 : a.first_seen_at > b.first_seen_at ? 1 : 0,
  "company:asc": (a, b) => a.company.localeCompare(b.company, undefined, { sensitivity: "base" }),
  "company:desc": (a, b) => b.company.localeCompare(a.company, undefined, { sensitivity: "base" }),
};
