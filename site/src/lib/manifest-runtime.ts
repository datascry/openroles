// Pure manifest validation and runtime URL construction.
//
// Split out of client-db.ts so that the validation logic is unit-tested by
// bun:test while the Worker bootstrap (which needs a real browser) lives
// in client-db.ts and is exercised end-to-end by Playwright.

const DB_FILENAME_RE = /^jobs\.[0-9a-f]{7,40}\.sqlite(?:\.gz)?$/;
const SHORT_SHA_RE = /^[0-9a-f]{7,40}$/;
const SLIM_CHUNK_FILE_RE = /^slim\/slim-\d{4}-[0-9a-f]{16}\.json\.gz$/;
const SLIM_CHUNK_SHA_RE = /^[0-9a-f]{16}$/;

export interface SlimChunkRuntime {
  readonly file: string;
  readonly sha: string;
  readonly rows: number;
  readonly bytes_gz: number;
  readonly bytes_raw: number;
  readonly posted_min: string | null;
  readonly posted_max: string | null;
  readonly has_null_posted: boolean;
}

export interface ManifestRuntime {
  readonly db_filename: string;
  readonly short_sha: string;
  readonly built_at: string;
  readonly total_rows: number;
  readonly tenants_total: number;
  readonly tenants_live: number;
  // Phase 13: chunked-mode SQLite metadata. Zero on pre-1.4.0 manifests
  // (the pre-chunked client bootstrap should fall back to single-file
  // mode in that case, but in practice we deploy from one repo so the
  // versions march together).
  readonly db_filesize_bytes: number;
  readonly db_chunk_size_bytes: number;
  readonly db_chunk_count: number;
  readonly db_suffix_length: number;
  // Phase 14: client-side slim index. Empty array on pre-1.5.0 manifests;
  // the FilterTable falls back to the legacy SQLite filter path when
  // slim_index_chunks is empty. See specs/slim-index.md.
  readonly slim_index_schema_version: string;
  readonly slim_index_total_rows: number;
  readonly slim_index_chunks: ReadonlyArray<SlimChunkRuntime>;
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
    db_filesize_bytes: asNonNegInt(m["db_filesize_bytes"] ?? 0, "db_filesize_bytes"),
    db_chunk_size_bytes: asNonNegInt(m["db_chunk_size_bytes"] ?? 0, "db_chunk_size_bytes"),
    db_chunk_count: asNonNegInt(m["db_chunk_count"] ?? 0, "db_chunk_count"),
    db_suffix_length: asNonNegInt(m["db_suffix_length"] ?? 0, "db_suffix_length"),
    slim_index_schema_version:
      typeof m["slim_index_schema_version"] === "string"
        ? (m["slim_index_schema_version"] as string)
        : "0.0",
    slim_index_total_rows: asNonNegInt(m["slim_index_total_rows"] ?? 0, "slim_index_total_rows"),
    slim_index_chunks: parseSlimChunks(m["slim_index_chunks"]),
  };
}

function parseSlimChunks(value: unknown): ReadonlyArray<SlimChunkRuntime> {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error("fetchManifest: expected slim_index_chunks to be an array");
  }
  return value.map((entry, idx) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(`fetchManifest: slim_index_chunks[${idx}] is not an object`);
    }
    const e = entry as Record<string, unknown>;
    const file = asString(e["file"], `slim_index_chunks[${idx}].file`);
    if (!SLIM_CHUNK_FILE_RE.test(file)) {
      throw new Error(
        `fetchManifest: slim_index_chunks[${idx}].file does not match the canonical shape`,
      );
    }
    const sha = asString(e["sha"], `slim_index_chunks[${idx}].sha`);
    if (!SLIM_CHUNK_SHA_RE.test(sha)) {
      throw new Error(`fetchManifest: slim_index_chunks[${idx}].sha must be 16 hex chars`);
    }
    return {
      file,
      sha,
      rows: asNonNegInt(e["rows"], `slim_index_chunks[${idx}].rows`),
      bytes_gz: asNonNegInt(e["bytes_gz"], `slim_index_chunks[${idx}].bytes_gz`),
      bytes_raw: asNonNegInt(e["bytes_raw"], `slim_index_chunks[${idx}].bytes_raw`),
      posted_min:
        e["posted_min"] === null
          ? null
          : asString(e["posted_min"], `slim_index_chunks[${idx}].posted_min`),
      posted_max:
        e["posted_max"] === null
          ? null
          : asString(e["posted_max"], `slim_index_chunks[${idx}].posted_max`),
      has_null_posted: e["has_null_posted"] === true,
    };
  });
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
  /**
   * URL prefix for chunked-mode reads. sql.js-httpvfs appends the
   * zero-padded chunk index — `${dbUrlPrefix}00000`, `${dbUrlPrefix}00001`,
   * etc. Empty when the manifest predates chunked mode (db_chunk_count=0).
   */
  readonly dbUrlPrefix: string;
  readonly workerUrl: string;
  readonly wasmUrl: string;
}

export function buildRuntimeUrls(basePath: string, manifest: ManifestRuntime): RuntimeUrls {
  const base = basePath.replace(/\/$/, "");
  // Strip the .gz suffix — sql.js-httpvfs reads the uncompressed file via
  // Range requests; the gzip artifact is for the GitHub Release attachment.
  const dbName = manifest.db_filename.replace(/\.gz$/, "");
  return {
    dbUrl: `${base}/data/${dbName}`,
    dbUrlPrefix: `${base}/data/${dbName}.`,
    workerUrl: `${base}/sqlite-vfs/sqlite.worker.js`,
    wasmUrl: `${base}/sqlite-vfs/sql-wasm.wasm`,
  };
}
