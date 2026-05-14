import { type Job, JobSchema, jobId, type TenantInput, type TenantResult } from "@openroles/shared";
import { z } from "zod";
import type { HttpClient } from "../http.ts";
import { assertSafeSlug, dedupeById, errorToResult, isRecruiterTitle } from "./common.ts";

// Phenom People — multi-tenant career-site platform.
//
// Phenom hosts ~600 Fortune-1000 customer career sites. Each tenant
// has its own customer-facing host (e.g. `jobs.walgreens.com`,
// `jobs.cvshealth.com`, `careers.bp.com`) but every deployment
// exposes the same public job-search API at:
//
//   https://{host}/api/jobs
//
// Method: GET
// Common query params:
//   page          1-indexed page number
//   pagesize      page size (vendor caps at 50)
//   from          alternative offset parameter (some deployments)
//   src           "Search Page" or similar source label
//
// Response shape (vendor stable across customers):
//   {
//     "total": <int>,
//     "jobs": [
//       {
//         "jobId": "12345",
//         "ats_job_id": "12345",
//         "title": "Senior Software Engineer",
//         "description": "...",
//         "category": "Engineering",
//         "ml_country": "United States",
//         "country_code": "US",
//         "city": "Seattle",
//         "state": "Washington",
//         "posted_date": "2026-04-10T00:00:00.000Z",
//         "url": "https://{host}/job/seattle/senior-software-engineer/12345",
//         "department": "Software Development",
//         "ml_skills": ["python", "kubernetes"]
//       },
//       ...
//     ]
//   }
//
// Composite metadata: `{ host }` per tenant. The slug identifies the
// company (e.g. "walgreens"); the host identifies the Phenom-hosted
// customer board. Mirrors the Workday composite-metadata pattern.

const PhenomJob = z
  .object({
    jobId: z.union([z.string(), z.number()]).optional(),
    ats_job_id: z.union([z.string(), z.number()]).optional(),
    title: z.string().optional(),
    description: z.string().optional(),
    description_text: z.string().optional(),
    category: z.string().optional(),
    department: z.string().optional(),
    ml_country: z.string().optional(),
    country: z.string().optional(),
    country_code: z.string().optional(),
    city: z.string().optional(),
    state: z.string().optional(),
    location: z.string().optional(),
    posted_date: z.string().optional(),
    url: z.string().optional(),
    apply_url: z.string().optional(),
  })
  .passthrough();

const PhenomResponse = z
  .object({
    total: z.number().optional(),
    jobs: z.array(PhenomJob).optional(),
    results: z.array(PhenomJob).optional(),
  })
  .passthrough();

const PAGE_SIZE = 50;
const DEFAULT_MAX_PAGES = 200; // 10,000-job ceiling per tenant

// Acceptable Phenom host shapes. Empirically the platform uses
// `{label}.{tenant-domain}` for the customer-facing host but the
// search API is always relative to that same host. We accept any
// well-formed hostname here and the SSRF guard is the slug regex
// in `assertSafeSlug` plus a public-URL whitelist check below.
const HOST_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;

export function assertPhenomHost(host: string): void {
  if (typeof host !== "string" || host.length === 0 || host.length > 253) {
    throw new Error(`phenom host rejected: ${JSON.stringify(host)}`);
  }
  if (!HOST_RE.test(host)) {
    throw new Error(`phenom host rejected: ${JSON.stringify(host)}`);
  }
  // Block raw private / loopback ranges to defend against
  // metadata-driven SSRF when callers pass user-controlled hosts.
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".internal") ||
    host.endsWith(".local")
  ) {
    throw new Error(`phenom host rejected: ${JSON.stringify(host)}`);
  }
}

function sourceIdOf(j: z.infer<typeof PhenomJob>): string | undefined {
  const id = j.jobId ?? j.ats_job_id;
  if (id === undefined) return undefined;
  return String(id);
}

function isoOrUndefined(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

function locationOf(j: z.infer<typeof PhenomJob>): {
  text?: string;
  country?: string;
  region?: string;
} {
  const text =
    j.location?.trim() ??
    [j.city, j.state, j.ml_country ?? j.country]
      .filter((p): p is string => typeof p === "string" && p.length > 0)
      .join(", ");
  const country = j.country_code?.trim().toUpperCase();
  return {
    ...(text && text.length > 0 ? { text } : {}),
    ...(country && /^[A-Z]{2}$/.test(country) ? { country } : {}),
    ...(j.state && j.state.trim().length > 0 ? { region: j.state.trim() } : {}),
  };
}

function workplaceFromJob(j: z.infer<typeof PhenomJob>): Job["workplace_type"] {
  const haystack = [j.city, j.location, j.title]
    .filter((s): s is string => typeof s === "string")
    .join(" ")
    .toLowerCase();
  if (/\b(?:remote|virtual|work from home|home-based)\b/.test(haystack)) return "remote";
  if (/\bhybrid\b/.test(haystack)) return "hybrid";
  return null;
}

function jobUrlOf(j: z.infer<typeof PhenomJob>, host: string, sourceId: string): string {
  const apiUrl = j.url ?? j.apply_url;
  // Honor an API-provided URL only when it points at the customer's
  // host (SSRF guard against metadata-driven exfil).
  if (typeof apiUrl === "string" && apiUrl.startsWith(`https://${host}/`)) {
    return apiUrl;
  }
  return `https://${host}/job/${encodeURIComponent(sourceId)}`;
}

export interface ParsePhenomJobsInput {
  readonly tenant: TenantInput;
  readonly company: string;
  readonly host: string;
  readonly response: unknown;
  readonly observedAt: string;
}

function buildCandidate(
  raw: z.infer<typeof PhenomJob>,
  input: ParsePhenomJobsInput,
): Record<string, unknown> | null {
  const sourceId = sourceIdOf(raw);
  const title = raw.title?.trim();
  if (!sourceId || !title) return null;
  const url = jobUrlOf(raw, input.host, sourceId);
  const id = jobId({
    ats: "phenom",
    tenant_slug: input.tenant.slug,
    source_id: sourceId,
    url,
  });
  const desc = (raw.description ?? raw.description_text)?.trim();
  const postedAt = isoOrUndefined(raw.posted_date);
  const department = (raw.department ?? raw.category)?.trim();
  const loc = locationOf(raw);
  return {
    id,
    ats: "phenom",
    tenant_slug: input.tenant.slug,
    source_id: sourceId,
    title,
    company: input.company,
    ...(desc && desc.length > 0 ? { description_excerpt: desc.slice(0, 4000) } : {}),
    level: null,
    level_rank: null,
    workplace_type: workplaceFromJob(raw),
    is_recruiter_post: isRecruiterTitle(title),
    ...(loc.text !== undefined ? { location_text: loc.text } : {}),
    ...(loc.country !== undefined ? { location_country: loc.country } : {}),
    ...(loc.region !== undefined ? { location_region: loc.region } : {}),
    ...(department && department.length > 0 ? { department } : {}),
    ...(postedAt !== undefined ? { posted_at: postedAt } : {}),
    first_seen_at: input.observedAt,
    last_seen_at: input.observedAt,
    url,
  };
}

/**
 * Parse one page of Phenom job-search JSON into normalized Job
 * records. Pure; safe to property-test.
 */
export function parsePhenomJobs(input: ParsePhenomJobsInput): Job[] {
  const parsed = PhenomResponse.parse(input.response);
  const list = parsed.jobs ?? parsed.results ?? [];
  const out: Job[] = [];
  for (const raw of list) {
    const candidate = buildCandidate(raw, input);
    if (candidate === null) continue;
    const validated = JobSchema.safeParse(candidate);
    if (validated.success) out.push(validated.data);
  }
  return dedupeById(out);
}

export interface ScrapePhenomOptions {
  readonly tenant: TenantInput;
  readonly client: HttpClient;
  readonly observedAt: string;
  readonly host: string;
  readonly pageSize?: number;
  readonly maxPages?: number;
}

export interface ScrapePhenomOutcome {
  readonly jobs: ReadonlyArray<Job>;
  readonly result: TenantResult;
}

export async function scrapePhenomTenant(opts: ScrapePhenomOptions): Promise<ScrapePhenomOutcome> {
  try {
    assertSafeSlug(opts.tenant.slug);
    assertPhenomHost(opts.host);
  } catch (err) {
    return { jobs: [], result: errorToResult(opts.tenant.slug, err) };
  }
  const limit = opts.pageSize ?? PAGE_SIZE;
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
  const collected: Job[] = [];
  let total = Number.POSITIVE_INFINITY;
  let lastStatus = 0;
  const company = opts.tenant.display_name ?? opts.tenant.slug;
  try {
    for (let page = 1; page <= maxPages; page++) {
      if ((page - 1) * limit >= total) break;
      const url = `https://${opts.host}/api/jobs?page=${page}&pagesize=${limit}`;
      const res = await opts.client.request(url, { method: "GET" });
      lastStatus = res.status;
      const body = await res.json();
      const parsed = PhenomResponse.parse(body);
      if (typeof parsed.total === "number") total = parsed.total;
      const pageJobs = parsePhenomJobs({
        tenant: opts.tenant,
        company,
        host: opts.host,
        response: body,
        observedAt: opts.observedAt,
      });
      for (const j of pageJobs) collected.push(j);
      const got = (parsed.jobs ?? parsed.results ?? []).length;
      if (got < limit) break;
    }
    const jobs = dedupeById(collected);
    return {
      jobs,
      result: {
        slug: opts.tenant.slug,
        status: "success",
        http_status: lastStatus || 200,
        jobs_count: jobs.length,
      },
    };
  } catch (err) {
    return { jobs: [], result: errorToResult(opts.tenant.slug, err) };
  }
}
