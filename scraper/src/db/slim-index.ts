// Emits the client-side slim index — a sequence of pre-gzipped JSON
// chunks, ordered newest-first, that the FilterTable loads in memory
// instead of running queries against a remote DB at runtime. The
// slim-index is the SOLE runtime data path (ADR-0012) — every field
// the client can render must be present in the chunks.
//
// Pattern matches what's been validated at scale by static-Pages job
// boards (see e.g. github.com/Feashliaa/job-board-aggregator at 1.7M
// jobs): split into ~50k-row chunks of ~700 KB gzipped each, ship via
// `Content-Encoding: gzip` (or pre-gzipped + DecompressionStream), let
// the client lazy-load and concatenate. Filter / sort / search become
// in-memory array operations — sub-50 ms after the index is loaded.
//
// We additionally:
//   - Sort chunks newest-first AND record each chunk's posted_at range
//     in the manifest, so date-range filters (since=24h, since=7d) can
//     skip loading older chunks entirely.
//   - Content-hash each chunk filename so they're cacheable forever in
//     a Service Worker; only `manifest.json` is mutable.
//   - Include `url` and `last_seen_at` in every row — `url` is the
//     direct apply destination (the row's primary action) and
//     `last_seen_at` powers the stale-row freshness label. Pre-ADR-
//     0012 these lived only in the SQLite that backed the role-detail
//     page; with the role-detail page removed they're hoisted into
//     the slim payload. URLs share long ATS-host prefixes
//     ("https://boards.greenhouse.io/", "https://jobs.lever.co/", …)
//     so gzip dedups them aggressively — empirical chunk-size impact
//     is +5-10% gz.
//
// See specs/data-schema.md (forthcoming) for the chunk JSON schema.

import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const SLIM_INDEX_SCHEMA_VERSION = "1.0";

// Default chunk row count. Tuned to keep per-chunk JSON.parse on the
// main thread under the 50ms long-task threshold. Empirically: 50k
// rows ≈ 14 MB raw / 2 MB gzipped, JSON.parse ~120-200ms (longtask).
// 20k rows ≈ 6 MB raw / 800 KB gzipped, JSON.parse ~50ms (just at
// the boundary; small chunks let V8 amortise GC pressure over more
// individual events instead of one big stop-the-world).
//
// 20k × 38 ≈ 750k rows. Manifest grows from 15 to ~38 entries
// (~50 bytes per entry, negligible). Service Worker cache cap of 64
// chunks (sw.js MAX_CHUNK_ENTRIES) accommodates the new count.
const DEFAULT_ROWS_PER_CHUNK = 20_000;

interface SlimRow {
  short_id: string;
  ats: string;
  tenant_slug: string;
  title: string;
  company: string;
  level: string | null;
  workplace_type: string | null;
  is_recruiter_post: number;
  is_stale: number;
  location_text: string | null;
  location_country: string | null;
  posted_at: string | null;
  first_seen_at: string;
  last_seen_at: string;
  compensation_min: number | null;
  compensation_max: number | null;
  compensation_currency: string | null;
  url: string;
}

/**
 * Serialised chunk shape on the wire. Each chunk is a flat array of
 * row objects — matches the ergonomics of `for (const r of rows)
 * if (matches(r)) ...` filtering, keeps JSON.parse fast, and lets us
 * stream-decode if a future client wants to.
 *
 * We deliberately did NOT dictionary-encode (vs. the SoA layout I
 * benchmarked) — at ~50k rows per chunk, the savings are minimal once
 * gzip runs (V8/JSC's repeated-string interning + gzip's LZ77 window
 * already collapse repeated atom values like "greenhouse"). Object
 * format keeps the client code one-line-trivial.
 */
type ChunkRowOnWire = {
  i: string; // short_id (16 hex chars)
  a: string; // ats
  t: string; // tenant_slug
  ti: string; // title
  c: string; // company
  l: string | null; // level
  w: string | null; // workplace_type
  r: 0 | 1; // is_recruiter_post
  s: 0 | 1; // is_stale
  loc: string | null; // location_text
  cc: string | null; // location_country
  p: string | null; // posted_at (ISO)
  f: string; // first_seen_at (ISO)
  ls: string; // last_seen_at (ISO) — drives the stale-row freshness label
  cm: number | null; // compensation_min
  cmax: number | null; // compensation_max
  cur: string | null; // compensation_currency
  u: string; // url — direct apply link to the source ATS posting
};

interface ChunkManifestEntry {
  /** Content-hashed filename, e.g. `slim-0-a1b2c3d4.json.gz`. */
  readonly file: string;
  /** SHA-256 of the *uncompressed* JSON body (lowercase hex, 16 chars). */
  readonly sha: string;
  /** Number of rows in this chunk. */
  readonly rows: number;
  /** Compressed (on-the-wire) size in bytes. */
  readonly bytes_gz: number;
  /** Uncompressed size in bytes. */
  readonly bytes_raw: number;
  /**
   * Posted-at range covered by this chunk. Inclusive both ends. ISO-8601 UTC.
   * Rows whose posted_at is null fall into the LAST chunk regardless of
   * date — no point stranding them in their own bucket. The client
   * treats "this chunk has nullable dates" as "must load if any
   * posted_at filter is active OR no posted_at filter is active."
   */
  readonly posted_min: string | null;
  readonly posted_max: string | null;
  /** True if any row in this chunk has posted_at IS NULL. */
  readonly has_null_posted: boolean;
}

export interface SlimIndexManifestFields {
  readonly slim_index_schema_version: string;
  readonly slim_index_total_rows: number;
  readonly slim_index_chunks: ReadonlyArray<ChunkManifestEntry>;
}

export interface EmitSlimIndexOptions {
  readonly outputDir: string;
  /** Subdirectory under outputDir for chunk files. Default: "slim". */
  readonly chunkSubdir?: string;
  /** Rows per chunk. Default: 50_000. */
  readonly rowsPerChunk?: number;
}

interface EmitResult {
  readonly fields: SlimIndexManifestFields;
  /** Absolute paths of the chunk files written, for staging-step copy globs. */
  readonly chunkPaths: ReadonlyArray<string>;
}

/**
 * Read all rows from the freshly-built jobs table, sort by posted_at
 * DESC NULLS LAST, slice into chunks of `rowsPerChunk`, and write each
 * chunk as a pre-gzipped JSON file alongside the SQLite chunks.
 *
 * The DB handle is read-only here; the caller still owns close().
 */
export async function emitSlimIndex(db: Database, opts: EmitSlimIndexOptions): Promise<EmitResult> {
  const subdir = opts.chunkSubdir ?? "slim";
  const rowsPerChunk = opts.rowsPerChunk ?? DEFAULT_ROWS_PER_CHUNK;
  if (rowsPerChunk < 1) {
    throw new Error(`emitSlimIndex: rowsPerChunk must be >= 1, got ${rowsPerChunk}`);
  }

  // Read the whole table. At our current row count (~750k) this is a
  // few hundred MB of in-process memory — comparable to the SQLite
  // file itself. If we ever push past ~10M rows, switch to a streaming
  // cursor (db.prepare(...).iterate()).
  const rows = readSlimRows(db);

  // Sort by posted_at DESC NULLS LAST, then first_seen_at DESC as tiebreaker.
  // This is the same canonical order the homepage uses, so chunk 0
  // contains exactly what the user wants to see first.
  rows.sort((a, b) => {
    const ap = a.posted_at;
    const bp = b.posted_at;
    if (ap !== null && bp !== null) {
      if (ap > bp) return -1;
      if (ap < bp) return 1;
    } else if (ap !== null) {
      return -1; // a sorts before null
    } else if (bp !== null) {
      return 1;
    }
    if (a.first_seen_at > b.first_seen_at) return -1;
    if (a.first_seen_at < b.first_seen_at) return 1;
    return 0;
  });

  const chunkDir = join(opts.outputDir, subdir);
  await ensureDir(chunkDir);

  const chunkEntries: ChunkManifestEntry[] = [];
  const chunkPaths: string[] = [];
  for (let chunkIdx = 0; chunkIdx * rowsPerChunk < rows.length; chunkIdx++) {
    const start = chunkIdx * rowsPerChunk;
    const end = Math.min(start + rowsPerChunk, rows.length);
    const slice = rows.slice(start, end);
    const onWire = slice.map(toOnWire);
    const json = JSON.stringify(onWire);
    const sha = sha256ShortHex(json);
    const fileName = `slim-${pad4(chunkIdx)}-${sha}.json.gz`;
    const filePath = join(chunkDir, fileName);
    const gz = gzipSync(json, { level: 9 });
    await writeFile(filePath, gz);
    chunkPaths.push(filePath);

    let postedMin: string | null = null;
    let postedMax: string | null = null;
    let hasNullPosted = false;
    for (const r of slice) {
      if (r.posted_at === null) {
        hasNullPosted = true;
      } else {
        if (postedMin === null || r.posted_at < postedMin) postedMin = r.posted_at;
        if (postedMax === null || r.posted_at > postedMax) postedMax = r.posted_at;
      }
    }
    chunkEntries.push({
      file: `${subdir}/${fileName}`,
      sha,
      rows: slice.length,
      bytes_gz: gz.length,
      bytes_raw: Buffer.byteLength(json, "utf-8"),
      posted_min: postedMin,
      posted_max: postedMax,
      has_null_posted: hasNullPosted,
    });
  }

  return {
    fields: {
      slim_index_schema_version: SLIM_INDEX_SCHEMA_VERSION,
      slim_index_total_rows: rows.length,
      slim_index_chunks: chunkEntries,
    },
    chunkPaths,
  };
}

function readSlimRows(db: Database): SlimRow[] {
  // ADR-0012: slim-index is the sole runtime data path. Every field
  // the FilterTable / row template renders must be present here. `url`
  // is the row's primary apply action, `last_seen_at` drives the stale
  // freshness label.
  const stmt = db.prepare<
    {
      id: string;
      ats: string;
      tenant_slug: string;
      title: string;
      company: string;
      level: string | null;
      workplace_type: string | null;
      is_recruiter_post: number;
      is_stale: number;
      location_text: string | null;
      location_country: string | null;
      posted_at: string | null;
      first_seen_at: string;
      last_seen_at: string;
      compensation_min: number | null;
      compensation_max: number | null;
      compensation_currency: string | null;
      url: string;
    },
    []
  >(`
    SELECT
      id, ats, tenant_slug, title, company,
      level, workplace_type, is_recruiter_post, is_stale,
      location_text, location_country, posted_at, first_seen_at, last_seen_at,
      compensation_min, compensation_max, compensation_currency, url
    FROM jobs
  `);
  const out: SlimRow[] = [];
  for (const r of stmt.all()) {
    out.push({
      short_id: r.id.slice(0, 16),
      ats: r.ats,
      tenant_slug: r.tenant_slug,
      title: r.title,
      company: r.company,
      level: r.level,
      workplace_type: r.workplace_type,
      is_recruiter_post: r.is_recruiter_post,
      is_stale: r.is_stale,
      location_text: r.location_text,
      location_country: r.location_country,
      posted_at: r.posted_at,
      first_seen_at: r.first_seen_at,
      last_seen_at: r.last_seen_at,
      compensation_min: r.compensation_min,
      compensation_max: r.compensation_max,
      compensation_currency: r.compensation_currency,
      url: r.url,
    });
  }
  return out;
}

function toOnWire(r: SlimRow): ChunkRowOnWire {
  return {
    i: r.short_id,
    a: r.ats,
    t: r.tenant_slug,
    ti: r.title,
    c: r.company,
    l: r.level,
    w: r.workplace_type,
    r: r.is_recruiter_post === 1 ? 1 : 0,
    s: r.is_stale === 1 ? 1 : 0,
    loc: r.location_text,
    cc: r.location_country,
    p: r.posted_at,
    f: r.first_seen_at,
    ls: r.last_seen_at,
    cm: r.compensation_min,
    cmax: r.compensation_max,
    cur: r.compensation_currency,
    u: r.url,
  };
}

function sha256ShortHex(input: string): string {
  // 16 hex chars = 64 bits — collision probability ~1e-9 across
  // ~100k chunks, fine for cache-busting.
  return createHash("sha256").update(input, "utf-8").digest("hex").slice(0, 16);
}

function pad4(n: number): string {
  return n.toString().padStart(4, "0");
}

async function ensureDir(path: string): Promise<void> {
  const fs = await import("node:fs/promises");
  await fs.mkdir(path, { recursive: true });
}
