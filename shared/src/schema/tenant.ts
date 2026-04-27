import { z } from "zod";
import { ATSIdSchema } from "./ats.ts";
import { HttpUrl } from "./url.ts";

const Slug = z.string().regex(/^[a-z0-9-]+$/, "must match [a-z0-9-]+");

const IsoUtc = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/);

export const TenantStatusSchema = z.enum(["live", "transient_failure", "dead"]);
export type TenantStatus = z.infer<typeof TenantStatusSchema>;

export const TenantSchema = z.object({
  ats: ATSIdSchema,
  slug: Slug,
  display_name: z.string().min(1).optional(),
  homepage_url: HttpUrl.optional(),
  status: TenantStatusSchema,
  last_probed_at: IsoUtc,
});

export type Tenant = z.infer<typeof TenantSchema>;
