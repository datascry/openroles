// Browser-only progressive loader for the slim-index. Split out of
// slim-index.ts because the fetch + Worker code can only run in a real
// browser — bun:test can't reach it, so it's exercised by Playwright
// e2e (see tests/e2e/slim-index.spec.ts) and excluded from per-file
// coverage thresholds via bunfig.toml.
//
// Public API:
//   loadSlimIndex(opts) — async; resolves once chunk 0 has merged into
//   `rows` and the remaining chunks are streaming in via Worker. The
//   `onChunk` callback fires after each chunk lands so callers can
//   refilter/re-render incrementally.

import type { ManifestRuntime, SlimChunkRuntime } from "./manifest-runtime.ts";
import { __test_internals as I, type SlimRow } from "./slim-index.ts";

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
 * Decompress + parse a single chunk URL. Pre-gzipped on origin and
 * served as `.json.gz`; Pages skips re-gzip on the already-compressed
 * extension and the browser receives the raw gzip bytes without
 * auto-decompressing — we run DecompressionStream ourselves.
 */
async function fetchAndDecompressChunk(url: string): Promise<SlimRow[]> {
  const res = await fetch(url, { cache: "force-cache" });
  if (!res.ok) {
    throw new Error(`fetchAndDecompressChunk: ${url} returned HTTP ${res.status}`);
  }
  const enc = res.headers.get("content-encoding");
  let text: string;
  if (enc === null || enc === "identity") {
    const blob = await res.blob();
    const ds = new DecompressionStream("gzip");
    const decompressed = blob.stream().pipeThrough(ds);
    text = await new Response(decompressed).text();
  } else {
    text = await res.text();
  }
  const onWire = JSON.parse(text) as ChunkRowOnWire[];
  return onWire.map(I.fromWire);
}

/**
 * Load the slim index progressively. Chunk 0 is fetched on the main
 * thread (first paint cares); the remaining chunks stream in via a
 * Web Worker so decompress + parse stays off-thread.
 *
 * If `manifest.slim_index_chunks` is empty, resolves immediately with
 * an empty result. Callers should then fall back to the legacy SQLite
 * path.
 */
export async function loadSlimIndex(opts: SlimIndexLoadOptions): Promise<SlimIndex> {
  const base = opts.basePath.replace(/\/$/, "");
  const chunks = opts.manifest.slim_index_chunks;
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

  const firstChunk = chunks[0];
  if (firstChunk === undefined) {
    return { rows, totalExpected, fullyLoaded: true };
  }
  const firstUrl = `${base}/data/${firstChunk.file}`;
  const firstRows = await fetchAndDecompressChunk(firstUrl);
  I.appendUnique(rows, firstRows);
  if (opts.onChunk) opts.onChunk(firstRows, rows.length, totalExpected);

  if (chunks.length === 1) {
    result.fullyLoaded = true;
    return result;
  }

  await loadRestInWorker(base, chunks.slice(1), opts.onChunk, rows, totalExpected);
  result.fullyLoaded = true;
  return result;
}

function loadRestInWorker(
  base: string,
  remaining: ReadonlyArray<SlimChunkRuntime>,
  onChunk: SlimIndexLoadOptions["onChunk"],
  target: SlimRow[],
  totalExpected: number,
): Promise<void> {
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
      const rows = ev.data.rows.map(I.fromWire);
      I.appendUnique(target, rows);
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
