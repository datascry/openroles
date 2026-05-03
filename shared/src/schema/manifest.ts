import { z } from "zod";
import { ATS_IDS, type ATSId } from "./ats.ts";

const IsoUtc = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/);

const SemVer = z.string().regex(/^\d+\.\d+\.\d+$/);
const ShortSha = z.string().regex(/^[0-9a-f]{7,40}$/);
const ChunkShortSha = z.string().regex(/^[0-9a-f]{16}$/);

const SlimChunkSchema = z
  .object({
    file: z
      .string()
      .regex(/^slim\/slim-\d{4}-[0-9a-f]{16}\.json\.gz$/, "must be slim/slim-NNNN-<sha>.json.gz"),
    sha: ChunkShortSha,
    rows: z.int().nonnegative(),
    bytes_gz: z.int().nonnegative(),
    bytes_raw: z.int().nonnegative(),
    posted_min: IsoUtc.nullable(),
    posted_max: IsoUtc.nullable(),
    has_null_posted: z.boolean(),
  })
  .strict();

// ats_counts is generated programmatically so the schema picks up new ATS
// ids automatically as ATS_IDS widens. Each key defaults to 0 so old
// manifests (built when ATS_IDS was narrower) remain readable; strict()
// still rejects unknown keys to catch typos. Downstream readers can
// `manifest.ats_counts[id]` without an undefined check because the parser
// fills missing keys.
const atsCountsShape = Object.fromEntries(
  ATS_IDS.map((id) => [id, z.int().nonnegative().default(0)]),
) as unknown as Record<ATSId, z.ZodDefault<z.ZodNumber>>;

const ATSCountsSchema = z.object(atsCountsShape).strict();

export const ManifestSchema = z
  .object({
    schema_version: SemVer,
    built_at: IsoUtc,
    short_sha: ShortSha,
    db_filename: z
      .string()
      .regex(/^jobs\.[0-9a-f]{7,40}\.sqlite(?:\.gz)?$/, "must be jobs.{short_sha}.sqlite(.gz)"),
    total_rows: z.int().nonnegative(),
    ats_counts: ATSCountsSchema,
    tenants_total: z.int().nonnegative(),
    tenants_live: z.int().nonnegative(),
    // Phase 12: role lifecycle. fresh_count + stale_count == total_rows
    // (cross-checked in superRefine below). Defaults preserve readability
    // of pre-1.3.0 manifests built before carry-forward existed.
    fresh_count: z.int().nonnegative().default(0),
    stale_count: z.int().nonnegative().default(0),
    stale_ttl_days: z.int().min(1).max(14).default(3),
    // Phase 13: SQLite is split into fixed-size chunks at build time so
    // sql.js-httpvfs can use serverMode: "chunked". GitHub Pages serves
    // files via chunked HTTP transfer-encoding (no Content-Length), which
    // sql.js-httpvfs's serverMode: "full" can't handle — it errors with
    // "Length of the file not known". chunked mode bypasses that by
    // baking the file size + chunk-layout into the manifest so the
    // client knows everything up-front and only needs byte-range reads.
    //
    // Defaults (zero) preserve readability of pre-1.4.0 manifests.
    db_filesize_bytes: z.int().nonnegative().default(0),
    db_chunk_size_bytes: z.int().nonnegative().default(0),
    db_chunk_count: z.int().nonnegative().default(0),
    db_suffix_length: z.int().nonnegative().default(0),
    // Phase 14: client-side slim index. Replaces the SQL-over-HTTP filter
    // path in FilterTable with an in-memory dataset of pre-gzipped JSON
    // chunks. Each chunk is content-hashed (cacheable forever via SW)
    // and the manifest records its posted_at range so date-window
    // filters can skip cold chunks. SQLite remains as the source of
    // truth and serves role-detail descriptions on click-through.
    //
    // Empty array on pre-1.5.0 manifests; clients fall back to the
    // legacy SQLite filter path when slim_index_chunks is empty.
    slim_index_schema_version: z.string().default("0.0"),
    slim_index_total_rows: z.int().nonnegative().default(0),
    slim_index_chunks: z.array(SlimChunkSchema).default([]),
  })
  .superRefine((m, ctx) => {
    if (m.tenants_live > m.tenants_total) {
      ctx.addIssue({
        code: "custom",
        path: ["tenants_live"],
        message: "must be <= tenants_total",
      });
    }
    const sum = ATS_IDS.reduce((acc, id) => acc + m.ats_counts[id], 0);
    if (sum !== m.total_rows) {
      ctx.addIssue({
        code: "custom",
        path: ["ats_counts"],
        message: `sum (${sum}) must equal total_rows (${m.total_rows})`,
      });
    }
    // Phase 12 invariant: fresh + stale == total. Manifests written by
    // pre-1.3.0 builds default to fresh_count=0 / stale_count=0 so we
    // skip the equality check when both counts are zero.
    if (m.fresh_count + m.stale_count !== 0) {
      if (m.fresh_count + m.stale_count !== m.total_rows) {
        ctx.addIssue({
          code: "custom",
          path: ["fresh_count"],
          message: `fresh_count (${m.fresh_count}) + stale_count (${m.stale_count}) must equal total_rows (${m.total_rows})`,
        });
      }
    }
    // Defense in depth: db_filename must embed short_sha. Both fields pass
    // their per-field regex independently, so a tampered manifest could ship
    // mismatched values; the cross-check rejects that. Mirrors the same
    // guard in site/src/lib/manifest-runtime.ts.
    const expectedPrefix = `jobs.${m.short_sha}.sqlite`;
    if (!m.db_filename.startsWith(expectedPrefix)) {
      ctx.addIssue({
        code: "custom",
        path: ["db_filename"],
        message: `must embed short_sha (${m.short_sha}); got ${m.db_filename}`,
      });
    }
    // Phase 14 invariant: per-chunk row counts must sum to slim_index_total_rows,
    // which in turn must equal total_rows whenever the slim index is active.
    // Defaults to 0 when the slim index isn't emitted, in which case we skip.
    if (m.slim_index_chunks.length > 0) {
      const chunkSum = m.slim_index_chunks.reduce((acc, c) => acc + c.rows, 0);
      if (chunkSum !== m.slim_index_total_rows) {
        ctx.addIssue({
          code: "custom",
          path: ["slim_index_chunks"],
          message: `chunk row sum (${chunkSum}) must equal slim_index_total_rows (${m.slim_index_total_rows})`,
        });
      }
      if (m.slim_index_total_rows !== m.total_rows) {
        ctx.addIssue({
          code: "custom",
          path: ["slim_index_total_rows"],
          message: `must equal total_rows (${m.total_rows}) when slim_index_chunks is non-empty; got ${m.slim_index_total_rows}`,
        });
      }
    }
  });

export type Manifest = z.infer<typeof ManifestSchema>;
