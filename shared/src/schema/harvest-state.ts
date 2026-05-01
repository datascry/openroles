import { z } from "zod";
import { ATSIdSchema } from "./ats.ts";

const SnapshotId = z.string().regex(/^\d{4}-\d{2}$/, "must match YYYY-NN");
const IsoUtc = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/);

/**
 * Per-ATS harvest state file.
 *
 * Tracks which CC-MAIN snapshot ids have already been processed for an
 * ATS, so an `--incremental` harvest can compute the diff against
 * `collinfo.json` and skip the redundant work that dominated the
 * pre-incremental weekly run. One file per ATS
 * (`data/harvest-state/{ats}.json`) so matrix-job legs never write
 * the same file. See docs/adr/0011-incremental-harvest-and-reprobe.md.
 */
export const HarvestStateSchema = z.object({
  schema_version: z.literal("1.0.0"),
  ats: ATSIdSchema,
  snapshots_processed: z.array(SnapshotId),
  tenant_count: z.int().nonnegative(),
  last_updated_at: IsoUtc,
});

export type HarvestState = z.infer<typeof HarvestStateSchema>;

export const HARVEST_STATE_SCHEMA_VERSION = "1.0.0" as const;
