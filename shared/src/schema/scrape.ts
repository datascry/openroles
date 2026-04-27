import { z } from "zod";
import { ATSIdSchema } from "./ats.ts";
import { JobSchema } from "./job.ts";
import { HttpUrl } from "./url.ts";

const Slug = z
  .string()
  .regex(/^[a-z0-9-]+$/)
  .min(1)
  .max(64);
const IsoUtc = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/);

const SafeMetadataKey = z
  .string()
  .regex(/^[a-zA-Z0-9_-]+$/)
  .min(1)
  .max(64);
const SafeMetadataValue = z.string().max(256);

export const TenantInputSchema = z.object({
  slug: Slug,
  display_name: z.string().min(1).max(128).optional(),
  metadata: z.record(SafeMetadataKey, SafeMetadataValue).optional(),
});

export type TenantInput = z.infer<typeof TenantInputSchema>;

const RetryPolicySchema = z.object({
  maxAttempts: z.int().min(1).max(10),
  baseMs: z.int().min(1).max(60_000),
  maxMs: z.int().min(1).max(600_000),
});

export const ScrapeInputSchema = z.object({
  ats: ATSIdSchema,
  tenants: z.array(TenantInputSchema),
  concurrency: z.int().min(1).max(64).optional(),
  userAgent: z.string().min(1),
  contactUrl: HttpUrl,
  retry: RetryPolicySchema.optional(),
});

export type ScrapeInput = z.infer<typeof ScrapeInputSchema>;

export const TenantResultStatusSchema = z.enum(["success", "transient_failure", "dead"]);
export type TenantResultStatus = z.infer<typeof TenantResultStatusSchema>;

export const TenantResultSchema = z.object({
  slug: Slug,
  status: TenantResultStatusSchema,
  http_status: z.int().min(0).max(599).optional(),
  error: z.string().optional(),
  jobs_count: z.int().nonnegative(),
});

export type TenantResult = z.infer<typeof TenantResultSchema>;

export const ScrapeMetricsSchema = z.object({
  started_at: IsoUtc,
  finished_at: IsoUtc,
  duration_ms: z.int().nonnegative(),
  requests_made: z.int().nonnegative(),
  requests_failed: z.int().nonnegative(),
  requests_retried: z.int().nonnegative(),
  bytes_received: z.int().nonnegative(),
});

export type ScrapeMetrics = z.infer<typeof ScrapeMetricsSchema>;

export const ScrapeOutputSchema = z.object({
  ats: ATSIdSchema,
  jobs: z.array(JobSchema),
  tenant_results: z.array(TenantResultSchema),
  metrics: ScrapeMetricsSchema,
});

export type ScrapeOutput = z.infer<typeof ScrapeOutputSchema>;
