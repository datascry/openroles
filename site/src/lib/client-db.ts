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

import type { QueryPlan } from "./filter-sql.ts";

// Manifest is already validated at build time by ManifestSchema in
// @openroles/shared. The client just defends against tampering by
// re-checking the safety-critical fields by hand — pulling zod into
// the client bundle would cost ~12 KB gzip for a one-shot validator.
const DB_FILENAME_RE = /^jobs\.[0-9a-f]{7,40}\.sqlite(?:\.gz)?$/;
const SHORT_SHA_RE = /^[0-9a-f]{7,40}$/;

export interface ManifestRuntime {
  readonly db_filename: string;
  readonly short_sha: string;
  readonly built_at: string;
  readonly total_rows: number;
  readonly tenants_total: number;
  readonly tenants_live: number;
}

function asString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`fetchManifest: expected ${field} to be a string`);
  }
  return value;
}

function asNonNegInt(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`fetchManifest: expected ${field} to be a non-negative integer`);
  }
  return value;
}

function parseManifest(body: unknown): ManifestRuntime {
  if (typeof body !== "object" || body === null) {
    throw new Error("fetchManifest: response body is not an object");
  }
  const m = body as Record<string, unknown>;
  const db_filename = asString(m["db_filename"], "db_filename");
  if (!DB_FILENAME_RE.test(db_filename)) {
    throw new Error("fetchManifest: db_filename does not match the canonical shape");
  }
  const short_sha = asString(m["short_sha"], "short_sha");
  if (!SHORT_SHA_RE.test(short_sha)) {
    throw new Error("fetchManifest: short_sha must be 7–40 hex chars");
  }
  return {
    db_filename,
    short_sha,
    built_at: asString(m["built_at"], "built_at"),
    total_rows: asNonNegInt(m["total_rows"], "total_rows"),
    tenants_total: asNonNegInt(m["tenants_total"], "tenants_total"),
    tenants_live: asNonNegInt(m["tenants_live"], "tenants_live"),
  };
}

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

export async function fetchManifest(
  basePath: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ManifestRuntime> {
  const url = `${basePath.replace(/\/$/, "")}/data/manifest.json`;
  const res = await fetchImpl(url, { cache: "no-cache" });
  if (!res.ok) {
    throw new Error(`fetchManifest: ${url} returned HTTP ${res.status}`);
  }
  const body = (await res.json()) as unknown;
  return parseManifest(body);
}

export async function loadClientDb(opts: LoadClientDbOptions): Promise<ClientDb> {
  const base = opts.basePath.replace(/\/$/, "");
  const manifest = await fetchManifest(base, opts.fetchImpl);
  const { createDbWorker } = await import("sql.js-httpvfs");
  const dbUrl = `${base}/data/${manifest.db_filename.replace(/\.gz$/, "")}`;
  const workerUrl = `${base}/sqlite-vfs/sqlite.worker.js`;
  const wasmUrl = `${base}/sqlite-vfs/sql-wasm.wasm`;
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
