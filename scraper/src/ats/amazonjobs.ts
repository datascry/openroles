import { type Job, JobSchema, jobId, type TenantInput, type TenantResult } from "@openroles/shared";
import { z } from "zod";
import type { HttpClient } from "../http.ts";
import { dedupeById, errorToResult, isRecruiterTitle } from "./common.ts";

// Amazon.jobs public JSON search API.
//
// Endpoint: https://amazon.jobs/en/search.json
// Query params (GET):
//   offset             pagination offset
//   result_limit       page size (vendor caps at 100)
//   sort               "recent" by default
//   normalized_country_code[]  optional country filter (omit to get global)
//
// Response shape:
//   {
//     "error": null,
//     "hits": <int>,                       // total matching jobs
//     "jobs": [
//       {
//         "id_icims": "1234567",
//         "title": "Senior Software Engineer",
//         "description_short": "...",
//         "posted_date": "April 10, 2026",  // locale-formatted, not ISO
//         "updated_time": "about 5 hours",  // locale string
//         "job_path": "/en/jobs/1234567/senior-software-engineer",
//         "city": "Seattle",
//         "state": "Washington",
//         "country_code": "US",
//         "primary_search_label": "Software Development",
//         "business_category": "Software Development",
//         "team": { "label": "AWS" }
//       },
//       ...
//     ]
//   }
//
// One tenant per company. The slug is `amazon`. Amazon used to use
// iCIMS underneath (id_icims is the residual); the wrapper above is
// vendor-public-but-undocumented and stable enough to ship.

const AmazonJob = z
  .object({
    id_icims: z.union([z.string(), z.number()]).nullish(),
    id: z.union([z.string(), z.number()]).nullish(),
    title: z.string().nullish(),
    description_short: z.string().nullish(),
    description: z.string().nullish(),
    posted_date: z.string().nullish(),
    updated_time: z.string().nullish(),
    job_path: z.string().nullish(),
    city: z.string().nullish(),
    state: z.string().nullish(),
    country_code: z.string().nullish(),
    location: z.string().nullish(),
    primary_search_label: z.string().nullish(),
    business_category: z.string().nullish(),
    team: z.object({ label: z.string().nullish() }).nullish(),
  })
  .passthrough();

const AmazonResponse = z
  .object({
    hits: z.number().optional(),
    jobs: z.array(AmazonJob).optional(),
    error: z.union([z.string(), z.null()]).optional(),
  })
  .passthrough();

const PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 50; // 5,000 jobs ceiling
const TENANT_SLUG = "amazon";

function workplaceFromJob(job: z.infer<typeof AmazonJob>): Job["workplace_type"] {
  const haystack = [job.location, job.title].filter(Boolean).join(" ").toLowerCase();
  if (/\bvirtual\b|\bremote\b|\bwork ?from ?home\b/.test(haystack)) return "remote";
  return null;
}

function locationText(job: z.infer<typeof AmazonJob>): string | undefined {
  if (typeof job.location === "string" && job.location.trim().length > 0)
    return job.location.trim();
  const parts = [job.city, job.state, job.country_code].filter(
    (s): s is string => typeof s === "string" && s.trim().length > 0,
  );
  if (parts.length === 0) return undefined;
  return parts.join(", ");
}

function postedAtIso(job: z.infer<typeof AmazonJob>): string | undefined {
  if (!job.posted_date) return undefined;
  // Amazon formats as "April 10, 2026" — Date.parse handles US-locale strings.
  const d = new Date(job.posted_date);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

function sourceIdOf(job: z.infer<typeof AmazonJob>): string | undefined {
  const id = job.id_icims ?? job.id;
  if (id === undefined || id === null) return undefined;
  return String(id);
}

function jobUrlOf(job: z.infer<typeof AmazonJob>, sourceId: string): string {
  if (typeof job.job_path === "string" && job.job_path.startsWith("/")) {
    return `https://amazon.jobs${job.job_path}`;
  }
  return `https://amazon.jobs/en/jobs/${encodeURIComponent(sourceId)}`;
}

export interface ParseAmazonJobsInput {
  readonly tenant: TenantInput;
  readonly company: string;
  readonly response: unknown;
  readonly observedAt: string;
}

function buildCandidate(
  raw: z.infer<typeof AmazonJob>,
  input: ParseAmazonJobsInput,
): Record<string, unknown> | null {
  const sourceId = sourceIdOf(raw);
  const title = raw.title?.trim();
  if (!sourceId || !title) return null;
  const url = jobUrlOf(raw, sourceId);
  const id = jobId({
    ats: "amazonjobs",
    tenant_slug: input.tenant.slug,
    source_id: sourceId,
    url,
  });
  const desc = (raw.description_short ?? raw.description)?.trim();
  const postedAt = postedAtIso(raw);
  const locText = locationText(raw);
  const department = raw.team?.label?.trim() ?? raw.business_category?.trim();
  const countryCode = raw.country_code?.trim().toUpperCase();
  return {
    id,
    ats: "amazonjobs",
    tenant_slug: input.tenant.slug,
    source_id: sourceId,
    title,
    company: input.company,
    ...(desc && desc.length > 0 ? { description_excerpt: desc.slice(0, 4000) } : {}),
    level: null,
    level_rank: null,
    workplace_type: workplaceFromJob(raw),
    is_recruiter_post: isRecruiterTitle(title),
    ...(locText !== undefined ? { location_text: locText } : {}),
    ...(countryCode && /^[A-Z]{2}$/.test(countryCode) ? { location_country: countryCode } : {}),
    ...(typeof raw.state === "string" && raw.state.trim().length > 0
      ? { location_region: raw.state.trim() }
      : {}),
    ...(department && department.length > 0 ? { department } : {}),
    ...(postedAt !== undefined ? { posted_at: postedAt } : {}),
    first_seen_at: input.observedAt,
    last_seen_at: input.observedAt,
    url,
  };
}

/**
 * Parse a single page of amazon.jobs search JSON into normalized Job
 * records. Pure; safe to property-test.
 */
export function parseAmazonJobs(input: ParseAmazonJobsInput): Job[] {
  const parsed = AmazonResponse.parse(input.response);
  const out: Job[] = [];
  for (const raw of parsed.jobs ?? []) {
    const candidate = buildCandidate(raw, input);
    if (candidate === null) continue;
    const validated = JobSchema.safeParse(candidate);
    if (validated.success) out.push(validated.data);
  }
  return dedupeById(out);
}

export interface ScrapeAmazonJobsOptions {
  readonly tenant: TenantInput;
  readonly client: HttpClient;
  readonly observedAt: string;
  readonly pageSize?: number;
  readonly maxPages?: number;
}

export interface ScrapeAmazonJobsOutcome {
  readonly jobs: ReadonlyArray<Job>;
  readonly result: TenantResult;
}

export async function scrapeAmazonJobsTenant(
  opts: ScrapeAmazonJobsOptions,
): Promise<ScrapeAmazonJobsOutcome> {
  // The single tenant is hard-coded to `amazon`; passing anything else is
  // a caller mistake. Reject early so the dispatcher's contract stays
  // explicit.
  if (opts.tenant.slug !== TENANT_SLUG) {
    return {
      jobs: [],
      result: {
        slug: opts.tenant.slug,
        status: "dead",
        error: `amazonjobs is a single-tenant ATS, slug must be "${TENANT_SLUG}"`,
        jobs_count: 0,
      },
    };
  }
  const limit = opts.pageSize ?? PAGE_SIZE;
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
  const collected: Job[] = [];
  let total = Number.POSITIVE_INFINITY;
  let lastStatus = 0;
  const company = opts.tenant.display_name ?? "Amazon";
  try {
    for (let page = 0; page < maxPages; page++) {
      const offset = page * limit;
      if (offset >= total) break;
      // Vendor wants GET with query-string pagination. The user-facing
      // path /en/search includes a noindex robots directive but the
      // .json endpoint is the documented public API for search.
      const url = `https://amazon.jobs/en/search.json?offset=${offset}&result_limit=${limit}&sort=recent`;
      const res = await opts.client.request(url, { method: "GET" });
      lastStatus = res.status;
      const body = await res.json();
      const parsed = AmazonResponse.parse(body);
      if (typeof parsed.hits === "number") total = parsed.hits;
      const pageJobs = parseAmazonJobs({
        tenant: opts.tenant,
        company,
        response: body,
        observedAt: opts.observedAt,
      });
      for (const j of pageJobs) collected.push(j);
      const got = parsed.jobs?.length ?? 0;
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
