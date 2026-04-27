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

import type { QueryPlan } from "./filter-sql.ts";
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
  const { dbUrl, workerUrl, wasmUrl } = buildRuntimeUrls(base, manifest);
  const worker = await createDbWorker(
    [
      {
        from: "inline",
        config: {
          serverMode: "full",
          url: dbUrl,
          requestChunkSize: 1024,
        },
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

export function runPlan<T>(db: ClientDb, plan: QueryPlan): Promise<T[]> {
  return db.query<T>(plan.sql, plan.params);
}
