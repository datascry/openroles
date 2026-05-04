// Browser-only progressive loader for the slim-index. All CPU-heavy
// work — fetch, decompress, JSON.parse, fromWire mapping — happens
// in a Web Worker. The main thread receives chunk results as JSON
// STRINGS (cheap to structured-clone) and re-parses them with a
// single fast V8 native call before merging.
//
// This is a complete rewrite vs the previous version where chunk 0
// was inline on the main thread. That inline path was the single
// 8.7-second freeze our perf probe caught — fetching + parsing +
// fromWire-mapping a 14 MB / 50k-object chunk on the main thread
// blocks every interaction. Now chunk 0 goes through the worker too
// and the SSR pre-paint covers the moment between page-arrival and
// chunk-0-merged.
//
// Search-index loading also funnels through this worker (different
// message type) so the +5 MB JSON.parse for stem postings doesn't
// freeze the tab when the user types.

import type { ManifestRuntime } from "./manifest-runtime.ts";
import { __test_internals as I, type SlimRow } from "./slim-index.ts";

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
   * Called once, after every chunk has merged. Use it to kick off
   * background work that depends on the full corpus — e.g. fetching
   * the stem-aware search index so the next user query doesn't pay
   * the download tax inline.
   */
  readonly onFullyLoaded?: () => void;
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
  /**
   * Fetches the search-index JSON via the same worker (off-main-thread
   * fetch + decompress) and returns the raw text body for the caller
   * to parse with site/src/lib/search-tokens.ts#parseSearchIndex.
   * Returns null if the fetch fails — callers fall back to substring
   * search.
   */
  fetchSearchIndexText(): Promise<string | null>;
}

interface WorkerMessage {
  readonly type: "chunk-done" | "search-done" | "error";
  readonly id: number;
  readonly rowsJson?: string;
  readonly count?: number;
  readonly jsonText?: string;
  readonly error?: string;
}

interface ChunkResolver {
  readonly resolve: (rows: SlimRow[]) => void;
  readonly reject: (err: Error) => void;
}

interface SearchResolver {
  readonly resolve: (text: string) => void;
  readonly reject: (err: Error) => void;
}

/**
 * Load the slim index progressively. Returns immediately once the
 * worker has been constructed; the rows array fills in as each chunk
 * lands. Caller observes progress via `onChunk` and can read
 * `result.rows` / `result.fullyLoaded` at any time.
 *
 * If `manifest.slim_index_chunks` is empty, resolves immediately
 * with an empty result. Callers should fall back to the legacy
 * SQLite path in that case.
 */
export async function loadSlimIndex(opts: SlimIndexLoadOptions): Promise<SlimIndex> {
  const base = opts.basePath.replace(/\/$/, "");
  const chunks = opts.manifest.slim_index_chunks;
  const totalExpected = opts.manifest.slim_index_total_rows;

  // Mutable accumulator. Caller sees the same array reference grow
  // as chunks arrive.
  const rows: SlimRow[] = opts.seed ? [...opts.seed] : [];

  if (chunks.length === 0) {
    return {
      rows,
      totalExpected,
      fullyLoaded: true,
      fetchSearchIndexText: async () => null,
    };
  }

  const workerUrl = `${base}/sqlite-vfs/slim-index-worker.js`;
  const worker = new Worker(workerUrl, { type: "module" });
  let nextId = 1;
  const chunkResolvers = new Map<number, ChunkResolver>();
  const searchResolvers = new Map<number, SearchResolver>();

  worker.onmessage = (ev: MessageEvent<WorkerMessage>) => {
    const msg = ev.data;
    if (msg.type === "chunk-done") {
      const r = chunkResolvers.get(msg.id);
      if (!r) {
        console.warn(`[loader] no resolver for chunk-done id=${msg.id}`);
        return;
      }
      chunkResolvers.delete(msg.id);
      const parsed = JSON.parse(msg.rowsJson ?? "[]") as SlimRow[];
      r.resolve(parsed);
      return;
    }
    if (msg.type === "search-done") {
      const r = searchResolvers.get(msg.id);
      if (!r) return;
      searchResolvers.delete(msg.id);
      r.resolve(msg.jsonText ?? "");
      return;
    }
    if (msg.type === "error") {
      const reject = chunkResolvers.get(msg.id)?.reject ?? searchResolvers.get(msg.id)?.reject;
      chunkResolvers.delete(msg.id);
      searchResolvers.delete(msg.id);
      if (reject) reject(new Error(msg.error ?? "slim-index worker error"));
      return;
    }
  };
  worker.onerror = (ev) => {
    for (const r of chunkResolvers.values()) r.reject(new Error(`worker: ${ev.message}`));
    for (const r of searchResolvers.values()) r.reject(new Error(`worker: ${ev.message}`));
    chunkResolvers.clear();
    searchResolvers.clear();
  };

  function requestChunk(url: string): Promise<SlimRow[]> {
    const id = nextId++;
    return new Promise<SlimRow[]>((resolve, reject) => {
      chunkResolvers.set(id, { resolve, reject });
      worker.postMessage({ type: "chunk", url, id });
    });
  }

  function requestSearchIndex(url: string): Promise<string> {
    const id = nextId++;
    return new Promise<string>((resolve, reject) => {
      searchResolvers.set(id, { resolve, reject });
      worker.postMessage({ type: "search", url, id });
    });
  }

  const result: {
    rows: SlimRow[];
    totalExpected: number;
    fullyLoaded: boolean;
    fetchSearchIndexText: () => Promise<string | null>;
  } = {
    rows,
    totalExpected,
    fullyLoaded: false,
    fetchSearchIndexText: async () => {
      try {
        return await requestSearchIndex(`${base}/data/search/title-tokens.json.gz`);
      } catch {
        return null;
      }
    },
  };

  // Kick off chunk 0 inline (caller awaits us until it lands), then
  // fan out the rest in parallel and resolve when every chunk has
  // merged. Chunk 0 inline so the FilterTable's first runFilter pass
  // has real data to operate on.
  const firstChunk = chunks[0];
  if (firstChunk === undefined) {
    return { ...result, fullyLoaded: true };
  }
  const firstUrl = `${base}/data/${firstChunk.file}`;
  const firstRows = await requestChunk(firstUrl);
  I.appendUnique(rows, firstRows);
  if (opts.onChunk) opts.onChunk(firstRows, rows.length, totalExpected);

  if (chunks.length === 1) {
    return { ...result, fullyLoaded: true };
  }

  // Process the rest sequentially. The worker is single-threaded, so
  // running 37 requestChunk calls concurrently buys us no throughput —
  // just hundreds of MB of in-flight gzipped Blobs + parsed JSON
  // strings piling up in worker memory. The earlier fan-out version
  // looked correct on small datasets but fell over at full scale:
  // the worker would queue every fetch up front, then memory pressure
  // (or browser fetch-throttling, which holds reads at 6-per-origin)
  // stalled chunks 1-N indefinitely so only chunk 0 ever merged.
  // Sequential processing peaks memory at one chunk's working set
  // (~12MB) and keeps onChunk firing predictably.
  const rest = chunks.slice(1);
  const allDone = (async () => {
    for (const chunk of rest) {
      try {
        const r = await requestChunk(`${base}/data/${chunk.file}`);
        I.appendUnique(rows, r);
        if (opts.onChunk) opts.onChunk(r, rows.length, totalExpected);
      } catch (err) {
        // Soft-fail one chunk: log to the console (worker reports
        // failures on its own postMessage), keep going for the rest.
        if (typeof console !== "undefined" && console.warn) {
          console.warn("slim-index chunk failed", chunk.file, err);
        }
      }
      // Diagnostic hook: expose cumulative row count to window so
      // perf probes / Playwright tests can verify chunks actually
      // merge into the in-memory dataset.
      if (typeof globalThis !== "undefined") {
        // biome-ignore lint/suspicious/noExplicitAny: diagnostic global
        (globalThis as any).__slimIndexRowsLength = rows.length;
      }
    }
  })();
  // Don't await — fire and forget. Caller can poll fullyLoaded.
  // We do still want to flip the flag once everything settles.
  void allDone.then(() => {
    result.fullyLoaded = true;
    if (typeof globalThis !== "undefined") {
      // biome-ignore lint/suspicious/noExplicitAny: diagnostic global
      (globalThis as any).__slimIndexFullyLoaded = true;
    }
    if (opts.onFullyLoaded) opts.onFullyLoaded();
  });

  return result;
}
