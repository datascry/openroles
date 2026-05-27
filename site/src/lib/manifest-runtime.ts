// Manifest validation for the slim-index runtime.
//
// ADR-0012 dropped the chunked-SQLite path. The manifest still carries
// build metadata (built_at, total_rows, tenants_*) plus the slim-index
// chunk list — this module parses and validates that subset.

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
  readonly built_at: string;
  /**
   * Short git SHA of the build. Used as the cache key for
   * site/src/lib/slim-index-cache.ts — a new SHA means a new corpus
   * and invalidates the previous cached merged dataset.
   */
  readonly short_sha: string;
  readonly total_rows: number;
  readonly tenants_total: number;
  readonly tenants_live: number;
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
  return {
    built_at: asString(m["built_at"], "built_at"),
    short_sha: asString(m["short_sha"], "short_sha"),
    total_rows: asNonNegInt(m["total_rows"], "total_rows"),
    tenants_total: asNonNegInt(m["tenants_total"], "tenants_total"),
    tenants_live: asNonNegInt(m["tenants_live"], "tenants_live"),
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
  // mutable pointer in the stack (slim-index chunk filenames are
  // content-hashed and immutable).
  const res = await fetchImpl(url, { cache: "no-cache" });
  if (!res.ok) {
    throw new Error(`fetchManifest: ${url} returned HTTP ${res.status}`);
  }
  const body = (await res.json()) as unknown;
  return parseManifest(body);
}
