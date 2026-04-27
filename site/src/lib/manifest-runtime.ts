// Pure manifest validation and runtime URL construction.
//
// Split out of client-db.ts so that the validation logic is unit-tested by
// bun:test while the Worker bootstrap (which needs a real browser) lives
// in client-db.ts and is exercised end-to-end by Playwright.

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

export function parseManifest(body: unknown): ManifestRuntime {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
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
  // Defense in depth: require the two fields to agree. The build-time
  // ManifestSchema validates each independently; cross-checking at fetch
  // time means a tampered manifest cannot ship one field while leaving
  // the other untouched. Audit-driven (Phase 8 review M1).
  if (!db_filename.startsWith(`jobs.${short_sha}.sqlite`)) {
    throw new Error(
      `fetchManifest: db_filename (${db_filename}) short_sha does not match short_sha field (${short_sha})`,
    );
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

export async function fetchManifest(
  basePath: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ManifestRuntime> {
  const url = `${basePath.replace(/\/$/, "")}/data/manifest.json`;
  // `no-cache` revalidates on every load; the deployed manifest is the only
  // mutable pointer in the stack (jobs.{sha}.sqlite is content-hashed and
  // immutable per ADR-0002).
  const res = await fetchImpl(url, { cache: "no-cache" });
  if (!res.ok) {
    throw new Error(`fetchManifest: ${url} returned HTTP ${res.status}`);
  }
  const body = (await res.json()) as unknown;
  return parseManifest(body);
}

export interface RuntimeUrls {
  readonly dbUrl: string;
  readonly workerUrl: string;
  readonly wasmUrl: string;
}

export function buildRuntimeUrls(basePath: string, manifest: ManifestRuntime): RuntimeUrls {
  const base = basePath.replace(/\/$/, "");
  return {
    // Strip the .gz suffix — sql.js-httpvfs reads the uncompressed file via
    // Range requests; the gzip artifact is for the GitHub Release attachment.
    dbUrl: `${base}/data/${manifest.db_filename.replace(/\.gz$/, "")}`,
    workerUrl: `${base}/sqlite-vfs/sqlite.worker.js`,
    wasmUrl: `${base}/sqlite-vfs/sql-wasm.wasm`,
  };
}
