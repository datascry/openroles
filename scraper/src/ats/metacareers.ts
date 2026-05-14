import { type Job, JobSchema, jobId, type TenantInput, type TenantResult } from "@openroles/shared";
import { z } from "zod";
import type { HttpClient } from "../http.ts";
import { dedupeById, errorToResult, isRecruiterTitle } from "./common.ts";

// metacareers.com public job-search REST API.
//
// Endpoint: https://www.metacareers.com/graphql
//   (the documented public search endpoint; alternatively the REST
//   fallback at /api/jobs returns the same shape.)
// Method: POST, content-type: application/json
// Body (REST):
//   {
//     "filters": {
//       "divisions": [],
//       "offices": [],
//       "roles": [],
//       "leadership_levels": [],
//       "saved_jobs": false,
//       "saved_searches": false,
//       "is_in_page": true
//     },
//     "page": 1,
//     "results_per_page": 50,
//     "sort_by": "newest"
//   }
//
// Response shape (vendor stable):
//   {
//     "total_results": <int>,
//     "jobs": [
//       {
//         "id": "v1-1234567890",
//         "title": "Software Engineer, Reality Labs",
//         "description": "...",
//         "url": "https://www.metacareers.com/jobs/1234567890/",
//         "locations": [
//           { "label": "Menlo Park, CA", "country": "United States", "region": "California" }
//         ],
//         "team": "Reality Labs",
//         "leadership_levels": ["IC4", "IC5"],
//         "is_leadership": false,
//         "posted_date": "2026-04-10"
//       },
//       ...
//     ]
//   }
//
// One tenant per company; slug is `meta`. Notes:
//   - Meta routes career traffic through Cloudflare; with a polite
//     UA and no aggressive concurrency the public endpoint is
//     consistently reachable.
//   - The `id` field is prefixed (`v1-…`) and not numeric. Treat
//     as opaque string.

const MetaLocation = z
  .object({
    label: z.string().optional(),
    country: z.string().optional(),
    region: z.string().optional(),
    state: z.string().optional(),
    city: z.string().optional(),
    country_code: z.string().optional(),
  })
  .passthrough();

const MetaJob = z
  .object({
    id: z.union([z.string(), z.number()]).optional(),
    title: z.string().optional(),
    description: z.string().optional(),
    url: z.string().optional(),
    locations: z.array(MetaLocation).optional(),
    team: z.string().optional(),
    division: z.string().optional(),
    leadership_levels: z.array(z.string()).optional(),
    is_leadership: z.boolean().optional(),
    posted_date: z.string().optional(),
  })
  .passthrough();

const MetaResponse = z
  .object({
    total_results: z.number().optional(),
    jobs: z.array(MetaJob).optional(),
    results: z.array(MetaJob).optional(),
  })
  .passthrough();

const PAGE_SIZE = 50;
const DEFAULT_MAX_PAGES = 100;
const TENANT_SLUG = "meta";

function sourceIdOf(j: z.infer<typeof MetaJob>): string | undefined {
  if (j.id !== undefined) return String(j.id);
  // Fall back to the numeric id embedded in the canonical url.
  if (typeof j.url === "string") {
    const m = /\/jobs\/([0-9]+)/.exec(j.url);
    if (m?.[1]) return m[1];
  }
  return undefined;
}

function isoOrUndefined(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

function locationOf(j: z.infer<typeof MetaJob>): {
  text?: string;
  country?: string;
  region?: string;
} {
  const first = j.locations?.[0];
  if (!first) return {};
  const text = first.label?.trim();
  const region = first.region?.trim() ?? first.state?.trim();
  // Prefer ISO-2 country code when supplied; otherwise leave undefined
  // (full country names like "United States" don't fit the
  // `location_country` ISO 3166-1 alpha-2 contract).
  const country = first.country_code?.trim().toUpperCase();
  return {
    ...(text && text.length > 0 ? { text } : {}),
    ...(country && /^[A-Z]{2}$/.test(country) ? { country } : {}),
    ...(region && region.length > 0 ? { region } : {}),
  };
}

function workplaceFromJob(j: z.infer<typeof MetaJob>): Job["workplace_type"] {
  const haystack = [j.title, j.locations?.[0]?.label]
    .filter((s): s is string => typeof s === "string")
    .join(" ")
    .toLowerCase();
  if (/\bremote\b/.test(haystack)) return "remote";
  return null;
}

function jobUrlOf(j: z.infer<typeof MetaJob>, sourceId: string): string {
  // Honor the API-provided url when shape-safe.
  if (typeof j.url === "string" && /^https:\/\/(?:www\.)?metacareers\.com\//.test(j.url)) {
    return j.url;
  }
  // Synthesize from the canonical pattern.
  return `https://www.metacareers.com/jobs/${encodeURIComponent(sourceId)}/`;
}

export interface ParseMetaJobsInput {
  readonly tenant: TenantInput;
  readonly company: string;
  readonly response: unknown;
  readonly observedAt: string;
}

function buildCandidate(
  raw: z.infer<typeof MetaJob>,
  input: ParseMetaJobsInput,
): Record<string, unknown> | null {
  const sourceId = sourceIdOf(raw);
  const title = raw.title?.trim();
  if (!sourceId || !title) return null;
  const url = jobUrlOf(raw, sourceId);
  const id = jobId({
    ats: "metacareers",
    tenant_slug: input.tenant.slug,
    source_id: sourceId,
    url,
  });
  const desc = raw.description?.trim();
  const postedAt = isoOrUndefined(raw.posted_date);
  const department = (raw.team ?? raw.division)?.trim();
  const loc = locationOf(raw);
  return {
    id,
    ats: "metacareers",
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
 * Parse one page of metacareers.com job-search JSON into Job records.
 * Pure; safe to property-test.
 */
export function parseMetaJobs(input: ParseMetaJobsInput): Job[] {
  const parsed = MetaResponse.parse(input.response);
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

export interface ScrapeMetaCareersOptions {
  readonly tenant: TenantInput;
  readonly client: HttpClient;
  readonly observedAt: string;
  readonly pageSize?: number;
  readonly maxPages?: number;
}

export interface ScrapeMetaCareersOutcome {
  readonly jobs: ReadonlyArray<Job>;
  readonly result: TenantResult;
}

export async function scrapeMetaCareersTenant(
  opts: ScrapeMetaCareersOptions,
): Promise<ScrapeMetaCareersOutcome> {
  if (opts.tenant.slug !== TENANT_SLUG) {
    return {
      jobs: [],
      result: {
        slug: opts.tenant.slug,
        status: "dead",
        error: `metacareers is a single-tenant ATS, slug must be "${TENANT_SLUG}"`,
        jobs_count: 0,
      },
    };
  }
  const limit = opts.pageSize ?? PAGE_SIZE;
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
  const collected: Job[] = [];
  let total = Number.POSITIVE_INFINITY;
  let lastStatus = 0;
  const company = opts.tenant.display_name ?? "Meta";
  try {
    for (let page = 1; page <= maxPages; page++) {
      if ((page - 1) * limit >= total) break;
      const res = await opts.client.request("https://www.metacareers.com/api/jobs", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          filters: {
            divisions: [],
            offices: [],
            roles: [],
            leadership_levels: [],
            saved_jobs: false,
            saved_searches: false,
            is_in_page: true,
          },
          page,
          results_per_page: limit,
          sort_by: "newest",
        }),
      });
      lastStatus = res.status;
      const body = await res.json();
      const parsed = MetaResponse.parse(body);
      if (typeof parsed.total_results === "number") total = parsed.total_results;
      const pageJobs = parseMetaJobs({
        tenant: opts.tenant,
        company,
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
