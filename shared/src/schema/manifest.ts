import { z } from "zod";
import { ATS_IDS, type ATSId } from "./ats.ts";

const IsoUtc = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/);

const SemVer = z.string().regex(/^\d+\.\d+\.\d+$/);
const ShortSha = z.string().regex(/^[0-9a-f]{7,40}$/);

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
  });

export type Manifest = z.infer<typeof ManifestSchema>;
