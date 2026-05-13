import { type Job, JobSchema, jobId, type TenantInput, type TenantResult } from "@openroles/shared";
import { z } from "zod";
import type { HttpClient } from "../http.ts";
import { dedupeById, errorToResult, isRecruiterTitle } from "./common.ts";

// jobs.apple.com public role-search API.
//
// Endpoint: https://jobs.apple.com/api/role/search
// Method: POST, content-type: application/json
// Body:
//   {
//     "query": "",                  // free-text search
//     "page": 1,                    // 1-indexed
//     "filters": {
//       "locations": [],            // array of region/post code filters
//       "products": [],
//       "teams": [],
//       "departments": []
//     }
//   }
//
// Response shape (vendor stable):
//   {
//     "totalRecords": <int>,
//     "pageSize": <int>,
//     "searchResults": [
//       {
//         "positionId": "200512345",
//         "postingTitle": "Senior Software Engineer",
//         "jobSummary": "...",
//         "locations": [
//           { "name": "Cupertino, California, United States", "country": "United States" }
//         ],
//         "postingDate": "2026-04-10T00:00:00.000Z",
//         "team": { "teamName": "Software and Services" },
//         "transparencyComp": null,
//         "homeOffice": false,
//         "managerial": "Individual Contributor"
//       },
//       ...
//     ]
//   }
//
// One tenant per company; slug is `apple`. Apple's anti-bot is
// lenient on this endpoint as of latest survey but may rate-limit
// aggressive callers — the scraper paginates with a generous delay
// budget by relying on HttpClient's exponential backoff.

const AppleLocation = z
  .object({
    name: z.string().optional(),
    country: z.string().optional(),
    countryCode: z.string().optional(),
  })
  .passthrough();

const AppleResult = z
  .object({
    positionId: z.union([z.string(), z.number()]).optional(),
    id: z.union([z.string(), z.number()]).optional(),
    postingTitle: z.string().optional(),
    title: z.string().optional(),
    jobSummary: z.string().optional(),
    summary: z.string().optional(),
    locations: z.array(AppleLocation).optional(),
    postingDate: z.string().optional(),
    team: z.object({ teamName: z.string().optional() }).optional(),
    department: z.string().optional(),
    homeOffice: z.boolean().optional(),
    managerial: z.string().optional(),
  })
  .passthrough();

const AppleResponse = z
  .object({
    totalRecords: z.number().optional(),
    pageSize: z.number().optional(),
    searchResults: z.array(AppleResult).optional(),
  })
  .passthrough();

const PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 50; // 5,000 jobs ceiling
const TENANT_SLUG = "apple";

function workplaceFromResult(r: z.infer<typeof AppleResult>): Job["workplace_type"] {
  if (r.homeOffice === true) return "remote";
  const locName = r.locations?.[0]?.name?.toLowerCase() ?? "";
  if (/\b(?:remote|virtual|home)\b/.test(locName)) return "remote";
  return null;
}

function locationOf(r: z.infer<typeof AppleResult>): {
  text?: string;
  country?: string;
  region?: string;
} {
  const first = r.locations?.[0];
  if (!first) return {};
  const text = first.name?.trim();
  // Apple's `country` is the full country name ("United States"); convert
  // to ISO-2 only when an explicit countryCode field is supplied.
  const country =
    typeof first.countryCode === "string" && /^[A-Z]{2}$/.test(first.countryCode)
      ? first.countryCode
      : undefined;
  // Parse "City, Region, Country" → region from middle slot when present.
  const parts =
    text
      ?.split(",")
      .map((p) => p.trim())
      .filter((p) => p.length > 0) ?? [];
  const region = parts.length >= 3 ? parts[parts.length - 2] : undefined;
  return {
    ...(text && text.length > 0 ? { text } : {}),
    ...(country ? { country } : {}),
    ...(region ? { region } : {}),
  };
}

function sourceIdOf(r: z.infer<typeof AppleResult>): string | undefined {
  const id = r.positionId ?? r.id;
  if (id === undefined) return undefined;
  return String(id);
}

function isoOrUndefined(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

export interface ParseAppleJobsInput {
  readonly tenant: TenantInput;
  readonly company: string;
  readonly response: unknown;
  readonly observedAt: string;
}

function buildCandidate(
  raw: z.infer<typeof AppleResult>,
  input: ParseAppleJobsInput,
): Record<string, unknown> | null {
  const sourceId = sourceIdOf(raw);
  const title = (raw.postingTitle ?? raw.title)?.trim();
  if (!sourceId || !title) return null;
  const url = `https://jobs.apple.com/en-us/details/${encodeURIComponent(sourceId)}`;
  const id = jobId({
    ats: "applejobs",
    tenant_slug: input.tenant.slug,
    source_id: sourceId,
    url,
  });
  const desc = (raw.jobSummary ?? raw.summary)?.trim();
  const postedAt = isoOrUndefined(raw.postingDate);
  const department = raw.team?.teamName?.trim() ?? raw.department?.trim();
  const loc = locationOf(raw);
  return {
    id,
    ats: "applejobs",
    tenant_slug: input.tenant.slug,
    source_id: sourceId,
    title,
    company: input.company,
    ...(desc && desc.length > 0 ? { description_excerpt: desc.slice(0, 4000) } : {}),
    level: null,
    level_rank: null,
    workplace_type: workplaceFromResult(raw),
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
 * Parse one page of jobs.apple.com role-search JSON into normalized
 * Job records. Pure; safe to property-test.
 */
export function parseAppleJobs(input: ParseAppleJobsInput): Job[] {
  const parsed = AppleResponse.parse(input.response);
  const out: Job[] = [];
  for (const raw of parsed.searchResults ?? []) {
    const candidate = buildCandidate(raw, input);
    if (candidate === null) continue;
    const validated = JobSchema.safeParse(candidate);
    if (validated.success) out.push(validated.data);
  }
  return dedupeById(out);
}

export interface ScrapeAppleJobsOptions {
  readonly tenant: TenantInput;
  readonly client: HttpClient;
  readonly observedAt: string;
  readonly pageSize?: number;
  readonly maxPages?: number;
}

export interface ScrapeAppleJobsOutcome {
  readonly jobs: ReadonlyArray<Job>;
  readonly result: TenantResult;
}

export async function scrapeAppleJobsTenant(
  opts: ScrapeAppleJobsOptions,
): Promise<ScrapeAppleJobsOutcome> {
  if (opts.tenant.slug !== TENANT_SLUG) {
    return {
      jobs: [],
      result: {
        slug: opts.tenant.slug,
        status: "dead",
        error: `applejobs is a single-tenant ATS, slug must be "${TENANT_SLUG}"`,
        jobs_count: 0,
      },
    };
  }
  const limit = opts.pageSize ?? PAGE_SIZE;
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
  const collected: Job[] = [];
  let total = Number.POSITIVE_INFINITY;
  let lastStatus = 0;
  const company = opts.tenant.display_name ?? "Apple";
  try {
    for (let page = 1; page <= maxPages; page++) {
      if ((page - 1) * limit >= total) break;
      const res = await opts.client.request("https://jobs.apple.com/api/role/search", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          query: "",
          page,
          locale: "en-us",
          sort: "newest",
          filters: { locations: [], products: [], teams: [], departments: [] },
        }),
      });
      lastStatus = res.status;
      const body = await res.json();
      const parsed = AppleResponse.parse(body);
      if (typeof parsed.totalRecords === "number") total = parsed.totalRecords;
      const pageJobs = parseAppleJobs({
        tenant: opts.tenant,
        company,
        response: body,
        observedAt: opts.observedAt,
      });
      for (const j of pageJobs) collected.push(j);
      const got = parsed.searchResults?.length ?? 0;
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
