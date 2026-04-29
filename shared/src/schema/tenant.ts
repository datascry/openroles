import { z } from "zod";
import { ATSIdSchema } from "./ats.ts";
import { HttpUrl } from "./url.ts";

const Slug = z.string().regex(/^[a-z0-9-]+$/, "must match [a-z0-9-]+");

const IsoUtc = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/);

// Tenant metadata is a per-ATS bag of keys the harvester extracts alongside
// the slug — used today by workday (`host`, `site`) and ultipro (`board_id`)
// where the public job-board URL needs more than the slug to compose.
// Constrained to safe ASCII to keep CSV / SQLite encoding predictable.
const MetadataKey = z
  .string()
  .regex(/^[a-zA-Z0-9_-]+$/)
  .min(1)
  .max(64);
const MetadataValue = z.string().min(1).max(256);

export const TenantStatusSchema = z.enum(["live", "transient_failure", "dead"]);
export type TenantStatus = z.infer<typeof TenantStatusSchema>;

export const TenantSchema = z.object({
  ats: ATSIdSchema,
  slug: Slug,
  display_name: z.string().min(1).optional(),
  homepage_url: HttpUrl.optional(),
  status: TenantStatusSchema,
  last_probed_at: IsoUtc,
  metadata: z.record(MetadataKey, MetadataValue).optional(),
});

export type Tenant = z.infer<typeof TenantSchema>;
