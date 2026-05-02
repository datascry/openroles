// Client-side SQLite query runtime via sql.js-httpvfs.
//
// At build time the scraper emits a single content-hashed SQLite (see ADR-0002).
// At runtime this module bootstraps a Web Worker that fetches b-tree pages over
// HTTP Range requests and runs SQL locally — no API server, no DB server.
//
// The worker and WASM blobs are loaded as static assets from the deployed site
// rather than bundled into the main JS chunk (Vite would otherwise inline them
// and blow the bundle budget). They're copied to /sqlite-vfs/ at site build by
// scripts/copy-sqlite-vfs.ts.
//
// Validation logic (parseManifest, buildRuntimeUrls) lives in
// manifest-runtime.ts so it can be unit-tested in bun:test without a Worker
// environment. This file is the Web-Worker glue and is exercised by Playwright.

import { buildRuntimeUrls, fetchManifest, type ManifestRuntime } from "./manifest-runtime.ts";

export type { ManifestRuntime, RuntimeUrls } from "./manifest-runtime.ts";
export { buildRuntimeUrls, fetchManifest, parseManifest } from "./manifest-runtime.ts";

export interface ClientDb {
  readonly query: <T = Record<string, unknown>>(
    sql: string,
    params: ReadonlyArray<string | number>,
  ) => Promise<T[]>;
  readonly manifest: ManifestRuntime;
  close(): void;
}

export interface LoadClientDbOptions {
  readonly basePath: string;
  readonly fetchImpl?: typeof fetch;
  readonly maxBytesToRead?: number;
}

export async function loadClientDb(opts: LoadClientDbOptions): Promise<ClientDb> {
  const base = opts.basePath.replace(/\/$/, "");
  const manifest = await fetchManifest(base, opts.fetchImpl);
  const { createDbWorker } = await import("sql.js-httpvfs");
  const { dbUrl, dbUrlPrefix, workerUrl, wasmUrl } = buildRuntimeUrls(base, manifest);

  // GitHub Pages serves with chunked HTTP transfer-encoding (no
  // Content-Length), and sql.js-httpvfs's `serverMode: "full"` errors
  // with "Length of the file not known" because the lib hardcodes
  // fileLength=undefined for that mode. Chunked mode bakes the file
  // size + layout into the manifest, so the client knows everything
  // up front and only needs byte-range reads inside each chunk file.
  // See specs/data-schema.md and ADR-0002.
  //
  // Manifests built before Phase 13 carry zeros for the chunk fields
  // — fall back to the legacy `full` mode for those. New deploys
  // always populate chunk metadata so this is the live path.
  const useChunked = manifest.db_chunk_count > 0 && manifest.db_chunk_size_bytes > 0;
  const config = useChunked
    ? {
        serverMode: "chunked" as const,
        urlPrefix: dbUrlPrefix,
        serverChunkSize: manifest.db_chunk_size_bytes,
        databaseLengthBytes: manifest.db_filesize_bytes,
        suffixLength: manifest.db_suffix_length,
        requestChunkSize: 4096,
      }
    : {
        serverMode: "full" as const,
        url: dbUrl,
        requestChunkSize: 4096,
      };
  const worker = await createDbWorker(
    [
      {
        from: "inline",
        config,
      },
    ],
    workerUrl,
    wasmUrl,
    opts.maxBytesToRead,
  );

  return {
    manifest,
    async query<T = Record<string, unknown>>(
      sql: string,
      params: ReadonlyArray<string | number>,
    ): Promise<T[]> {
      // sql.js-httpvfs's `query` forwards (...args) to sql.js's `db.exec`,
      // which is exec(sql, params?) with a SINGLE params arg. Passing the
      // array as one arg binds positional placeholders correctly; spreading
      // would call exec(sql, p0, p1, ...) and sql.js would only see p0,
      // failing with "datatype mismatch" when p0 is a non-array bind.
      return (await worker.db.query(sql, [...params])) as T[];
    },
    close() {
      // Comlink does not expose Worker.terminate(); the browser GCs the worker
      // once all references drop. Site-wide there is exactly one ClientDb, so
      // close() is effectively a marker that future usage is invalid.
    },
  };
}
