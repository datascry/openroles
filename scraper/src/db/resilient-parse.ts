// Resilient, per-row parsing for build-db inputs.
//
// The daily refresh reads a merged tenant list and a directory of scrape
// outputs, then feeds the valid rows into `buildDb`. A single malformed row
// — an underscore in a tenant slug, a dotted vendor domain, a control char
// in a job title — must never abort the build: the site would freeze at the
// last good deploy while scrapes keep succeeding, and the failure is silent.
//
// These helpers replace the eager `z.array(Schema).parse(...)` (throws on the
// first bad row) with a per-row `safeParse`: valid rows pass through unchanged,
// invalid rows are dropped and recorded so the caller can log one summary line.

import {
  ATSIdSchema,
  type Job,
  JobSchema,
  ScrapeMetricsSchema,
  type ScrapeOutput,
  type Tenant,
  TenantResultSchema,
  TenantSchema,
} from "@openroles/shared";
import { z } from "zod";

/** Maximum offending rows named in a single summary line before truncation. */
export const MAX_SKIP_SAMPLES = 20;

/**
 * A row rejected during resilient parsing, tagged with a best-effort identity
 * so the summary log points an operator straight at the offending tenant/job.
 */
export interface SkippedRow {
  /** The row's `ats` value, or "?" when it was itself missing/non-string. */
  readonly ats: string;
  /** The row's slug, or "?" when it was missing/non-string. */
  readonly slug: string;
  /** Compact label of the first field that failed, e.g. "slug" or "title". */
  readonly field: string;
  /** Full Zod issue string, for the record — `field message; field message`. */
  readonly reason: string;
}

/** Valid rows plus the rows that were dropped. */
export interface Partition<T> {
  readonly valid: T[];
  readonly skipped: SkippedRow[];
}

/** A scrape-output file split into its valid jobs and the jobs that were dropped. */
export interface ScrapeOutputPartition {
  /** The rebuilt output with only valid jobs, or null when the envelope itself was invalid. */
  readonly output: ScrapeOutput | null;
  /** Jobs dropped from an otherwise-valid envelope. */
  readonly skipped: SkippedRow[];
  /** Set only when the envelope (ats / metrics / tenant_results) failed — the whole file is unusable. */
  readonly envelopeError?: string;
}

/** Best-effort (ats, slug) label from an unvalidated record. */
function labelOf(raw: unknown, slugKey: "slug" | "tenant_slug"): { ats: string; slug: string } {
  const rec = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const ats = typeof rec["ats"] === "string" && rec["ats"].length > 0 ? rec["ats"] : "?";
  const slugVal = rec[slugKey];
  const slug = typeof slugVal === "string" && slugVal.length > 0 ? slugVal : "?";
  return { ats, slug };
}

/** Path of the first issue, e.g. "slug" or "metrics.started_at" — "(root)" when empty. */
function fieldOf(error: z.ZodError): string {
  const first = error.issues[0];
  if (first === undefined) return "(root)";
  return first.path.length > 0 ? first.path.join(".") : "(root)";
}

/** Full human-readable reason string joining every issue. */
function reasonOf(error: z.ZodError): string {
  return error.issues
    .map((i) => `${i.path.length > 0 ? i.path.join(".") : "(root)"} ${i.message}`)
    .join("; ");
}

/**
 * Split a raw tenants array into valid `Tenant`s and dropped rows.
 *
 * A non-array input (corrupt merge) yields zero valid rows and a single
 * skip describing the shape error, rather than throwing.
 */
export function partitionTenants(raw: unknown): Partition<Tenant> {
  const valid: Tenant[] = [];
  const skipped: SkippedRow[] = [];
  if (!Array.isArray(raw)) {
    skipped.push({
      ats: "?",
      slug: "?",
      field: "(root)",
      reason: "tenants input is not a JSON array",
    });
    return { valid, skipped };
  }
  for (const entry of raw) {
    const parsed = TenantSchema.safeParse(entry);
    if (parsed.success) {
      valid.push(parsed.data);
      continue;
    }
    const { ats, slug } = labelOf(entry, "slug");
    skipped.push({ ats, slug, field: fieldOf(parsed.error), reason: reasonOf(parsed.error) });
  }
  return { valid, skipped };
}

// Envelope with a lenient jobs field: validate ats / metrics / tenant_results
// up front (a broken envelope means the whole file is unusable) but defer each
// job to a per-row safeParse so one bad posting can't drop a tenant's corpus.
const LenientScrapeOutputSchema = z.object({
  ats: ATSIdSchema,
  jobs: z.array(z.unknown()),
  tenant_results: z.array(TenantResultSchema),
  metrics: ScrapeMetricsSchema,
});

/**
 * Split one scrape-output file into a rebuilt output carrying only valid jobs
 * plus the jobs that were dropped. When the envelope itself is invalid the
 * whole file is unusable — `output` is null and `envelopeError` explains why.
 */
export function partitionScrapeOutput(raw: unknown): ScrapeOutputPartition {
  const envelope = LenientScrapeOutputSchema.safeParse(raw);
  if (!envelope.success) {
    return { output: null, skipped: [], envelopeError: reasonOf(envelope.error) };
  }
  const jobs: Job[] = [];
  const skipped: SkippedRow[] = [];
  for (const entry of envelope.data.jobs) {
    const parsed = JobSchema.safeParse(entry);
    if (parsed.success) {
      jobs.push(parsed.data);
      continue;
    }
    const label = labelOf(entry, "tenant_slug");
    skipped.push({
      ats: label.ats === "?" ? envelope.data.ats : label.ats,
      slug: label.slug,
      field: fieldOf(parsed.error),
      reason: reasonOf(parsed.error),
    });
  }
  const output: ScrapeOutput = {
    ats: envelope.data.ats,
    jobs,
    tenant_results: envelope.data.tenant_results,
    metrics: envelope.data.metrics,
  };
  return { output, skipped };
}

/**
 * One-line stderr summary for a batch of skipped rows, or null when nothing was
 * skipped. Names up to {@link MAX_SKIP_SAMPLES} offenders and always reports the
 * true total, e.g.
 * `build-db: skipped 3 invalid tenant rows: workable/foo_bar (slug), ashby/kos.ai (slug)`.
 */
export function formatSkipSummary(kind: string, skipped: ReadonlyArray<SkippedRow>): string | null {
  if (skipped.length === 0) return null;
  const samples = skipped.slice(0, MAX_SKIP_SAMPLES).map((s) => `${s.ats}/${s.slug} (${s.field})`);
  const more = skipped.length - samples.length;
  const suffix = more > 0 ? `, +${more} more` : "";
  const plural = skipped.length === 1 ? "" : "s";
  return `build-db: skipped ${skipped.length} invalid ${kind} row${plural}: ${samples.join(", ")}${suffix}`;
}
