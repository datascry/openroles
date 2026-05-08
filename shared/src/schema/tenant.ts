import { z } from "zod";
import { ATSIdSchema } from "./ats.ts";
import { HttpUrl } from "./url.ts";

const Slug = z.string().regex(/^[a-z0-9-]+$/, "must match [a-z0-9-]+");

const IsoUtc = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/);

// Tenant metadata is a per-ATS bag of keys the harvester extracts alongside
// the slug — used today by workday (`host`, `site`) and ultipro (`board_id`)
// where the public job-board URL needs more than the slug to compose.
// Constrained to safe ASCII to keep CSV / SQLite encoding predictable.
//
// For workday tenants `site` is the per-tenant label that addresses the
// cxs JSON API at `/wday/cxs/{slug}/{site}/jobs`. It is auto-discovered
// from the tenant's `/robots.txt` Allow / Sitemap directives by the
// reprobe pass — see scraper/src/ats/workday-site-fetch.ts. When the
// label cannot be discovered the field is absent and the scraper falls
// back to the hardcoded External / Careers probe chain.
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
  // ISO-UTC timestamp recording when this slug first surfaced in any
  // harvest pass. Set once at discovery time and never overwritten —
  // distinguishes "we've known about this tenant for years" from "we
  // just found it today" without losing the signal across re-probes.
  // Optional during the migration window from pre-incremental tenant
  // files; backfilled to the current observedAt on first re-write.
  // See docs/adr/0011-incremental-harvest-and-reprobe.md.
  first_seen_at: IsoUtc.optional(),
  metadata: z.record(MetadataKey, MetadataValue).optional(),
});

export type Tenant = z.infer<typeof TenantSchema>;
