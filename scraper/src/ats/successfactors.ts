import { type Job, JobSchema, jobId, type TenantInput, type TenantResult } from "@openroles/shared";
import { z } from "zod";
import type { HttpClient } from "../http.ts";
import { assertSafeSlug, dedupeById, errorToResult, isRecruiterTitle } from "./common.ts";

// SAP SuccessFactors career-search public API.
//
// SuccessFactors is the SAP-owned ATS used by a meaningful slice of
// Fortune-500 hiring (SAP itself, Adidas, BMW, Costco, Publix, much of
// the EU-based manufacturing sector). The vendor exposes a public
// JSON Job Requisition search at the career-site root:
//
//   https://career{N}.successfactors.{eu|com|de}/careersection/rest/jobboard/search-jobs
//
// where {N} is the per-tenant datacenter shard (career2 / career4 /
// career5 most commonly) and the tld follows the tenant's region. The
// tenant identifier is passed in the request body under `siteName`
// (matches the customer-facing `?company={slug}` URL parameter).
//
// The public endpoint returns paginated json:
//
//   {
//     "facets": {...},
//     "jobs": [
//       {
//         "jobReqId": "12345",
//         "title": "Software Engineer",
//         "shortDescription": "...",
//         "datePosted": "2026-04-10T00:00:00Z",
//         "location": "Berlin, DE",
//         "department": "Engineering",
//         "url": "https://career4.successfactors.eu/career?company=acme&career_job_req_id=12345"
//       },
//       ...
//     ],
//     "totalCount": 42
//   }
//
// PRELIMINARY scaffold — module composition, schema bump (1.5.0), and
// fixture-replay tests are wired, but live validation against a real
// SF tenant is pending. The next reprobe pass against any
// hand-seeded SuccessFactors slug will confirm shapes; any deviation
// from this fixture surfaces as a JobSchema.safeParse failure
// in the per-job loop (which already silently drops malformed
// candidates), keeping production behavior safe under uncertainty.

const SuccessFactorsLocation = z.union([z.string(), z.null()]).optional();

const SuccessFactorsJob = z
  .object({
    jobReqId: z.union([z.string(), z.number()]).optional(),
    requisitionId: z.union([z.string(), z.number()]).optional(),
    title: z.string().optional(),
    shortDescription: z.string().optional(),
    description: z.string().optional(),
    datePosted: z.string().optional(),
    location: SuccessFactorsLocation,
    department: z.union([z.string(), z.null()]).optional(),
    url: z.string().optional(),
    remoteFlag: z.boolean().optional(),
    workplaceType: z.string().optional(),
  })
  .passthrough();

const SuccessFactorsResponse = z
  .object({
    jobs: z.array(SuccessFactorsJob).optional(),
    results: z.array(SuccessFactorsJob).optional(),
    totalCount: z.number().optional(),
  })
  .passthrough();

const PAGE_SIZE = 50;
const DEFAULT_MAX_PAGES = 200;

function pickResultsArray(
  body: z.infer<typeof SuccessFactorsResponse>,
): ReadonlyArray<z.infer<typeof SuccessFactorsJob>> {
  return body.jobs ?? body.results ?? [];
}

function workplaceTypeOf(job: z.infer<typeof SuccessFactorsJob>): Job["workplace_type"] {
  if (job.remoteFlag === true) return "remote";
  const wp = job.workplaceType?.toLowerCase();
  if (wp === "remote") return "remote";
  if (wp === "hybrid") return "hybrid";
  if (wp === "onsite" || wp === "on-site" || wp === "office") return "onsite";
  return null;
}

function isoOrUndefined(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

function locationText(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function jobUrlOf(
  slug: string,
  host: string,
  job: z.infer<typeof SuccessFactorsJob>,
  reqId: string,
): string {
  if (typeof job.url === "string" && /^https:\/\/[^\s]+$/.test(job.url)) return job.url;
  // Construct the canonical customer-facing URL when the API omits
  // it. The `career_job_req_id` URL parameter is what the vendor's
  // own apply-flow uses; the user lands on the correct posting.
  return `https://${host}/career?company=${slug}&career_job_req_id=${encodeURIComponent(reqId)}`;
}

export interface ParseSuccessFactorsInput {
  readonly tenant: TenantInput;
  readonly company: string;
  readonly host: string;
  readonly response: unknown;
  readonly observedAt: string;
}

function buildCandidate(
  raw: z.infer<typeof SuccessFactorsJob>,
  input: ParseSuccessFactorsInput,
): Record<string, unknown> | null {
  const reqIdRaw = raw.jobReqId ?? raw.requisitionId;
  const reqId = reqIdRaw === undefined ? undefined : String(reqIdRaw);
  const title = raw.title?.trim();
  if (!reqId || !title) return null;
  const url = jobUrlOf(input.tenant.slug, input.host, raw, reqId);
  const id = jobId({
    ats: "successfactors",
    tenant_slug: input.tenant.slug,
    source_id: reqId,
    url,
  });
  const desc = (raw.shortDescription ?? raw.description)?.trim();
  const postedAt = isoOrUndefined(raw.datePosted);
  const locText = locationText(raw.location);
  const dept =
    typeof raw.department === "string" && raw.department.trim().length > 0
      ? raw.department.trim()
      : undefined;
  return {
    id,
    ats: "successfactors",
    tenant_slug: input.tenant.slug,
    source_id: reqId,
    title,
    company: input.company,
    ...(desc && desc.length > 0 ? { description_excerpt: desc.slice(0, 4000) } : {}),
    level: null,
    level_rank: null,
    workplace_type: workplaceTypeOf(raw),
    is_recruiter_post: isRecruiterTitle(title),
    ...(locText !== undefined ? { location_text: locText } : {}),
    ...(dept !== undefined ? { department: dept } : {}),
    ...(postedAt !== undefined ? { posted_at: postedAt } : {}),
    first_seen_at: input.observedAt,
    last_seen_at: input.observedAt,
    url,
  };
}

/**
 * Parse a single page of SuccessFactors job-search JSON into normalized
 * Job records. Pure; safe to property-test.
 */
export function parseSuccessFactorsJobs(input: ParseSuccessFactorsInput): Job[] {
  const parsed = SuccessFactorsResponse.parse(input.response);
  const jobs: Job[] = [];
  for (const raw of pickResultsArray(parsed)) {
    const candidate = buildCandidate(raw, input);
    if (candidate === null) continue;
    const validated = JobSchema.safeParse(candidate);
    if (validated.success) jobs.push(validated.data);
  }
  return dedupeById(jobs);
}

// Acceptable SuccessFactors API host shape. Empirically the vendor
// uses `career{N}.successfactors.{eu|com|de|com.cn}` and a small set
// of regional aliases. Reject anything that isn't a literal
// successfactors.* host to prevent metadata-driven SSRF.
const SUCCESSFACTORS_HOST = /^career[0-9]{1,3}\.successfactors\.(?:com|eu|de|com\.cn|fr|co\.uk)$/;

export function assertSuccessFactorsHost(host: string): void {
  if (!SUCCESSFACTORS_HOST.test(host)) {
    throw new Error(`successfactors host rejected: ${JSON.stringify(host)}`);
  }
}

export interface ScrapeSuccessFactorsOptions {
  readonly tenant: TenantInput;
  readonly client: HttpClient;
  readonly observedAt: string;
  readonly host: string;
  readonly pageSize?: number;
  readonly maxPages?: number;
}

export interface ScrapeSuccessFactorsOutcome {
  readonly jobs: ReadonlyArray<Job>;
  readonly result: TenantResult;
}

export async function scrapeSuccessFactorsTenant(
  opts: ScrapeSuccessFactorsOptions,
): Promise<ScrapeSuccessFactorsOutcome> {
  try {
    assertSafeSlug(opts.tenant.slug);
    assertSuccessFactorsHost(opts.host);
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
    for (let page = 0; page < maxPages; page++) {
      const offset = page * limit;
      if (offset >= total) break;
      const url = `https://${opts.host}/careersection/rest/jobboard/search-jobs`;
      const res = await opts.client.request(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          siteName: opts.tenant.slug,
          offset,
          limit,
          searchText: "",
        }),
      });
      lastStatus = res.status;
      const body = await res.json();
      const parsed = SuccessFactorsResponse.parse(body);
      if (typeof parsed.totalCount === "number") total = parsed.totalCount;
      const page_jobs = parseSuccessFactorsJobs({
        tenant: opts.tenant,
        company,
        host: opts.host,
        response: body,
        observedAt: opts.observedAt,
      });
      for (const j of page_jobs) collected.push(j);
      const got = pickResultsArray(parsed).length;
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
