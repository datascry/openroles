import { type Job, JobSchema, jobId, type TenantInput, type TenantResult } from "@openroles/shared";
import { z } from "zod";
import type { HttpClient } from "../http.ts";
import { dedupeById, errorToResult, isRecruiterTitle } from "./common.ts";

// careers.tiktok.com public job-search API.
//
// Endpoint: https://careers.tiktok.com/api/v1/search/job/posts
// Method: POST, content-type: application/json
// Body:
//   {
//     "keyword": "",
//     "limit": 50,
//     "offset": 0,
//     "job_category_id_list": [],
//     "location_code_list": [],
//     "subject_id_list": []
//   }
//
// Response shape:
//   {
//     "code": 0,
//     "data": {
//       "count": 12345,
//       "job_post_list": [
//         {
//           "id": "7283456789012345678",
//           "title": "Software Engineer, Recommendation Algorithm",
//           "description": "...",
//           "city_info": { "name": "Seattle" },
//           "country_info": { "name": "United States", "code": "US" },
//           "job_category": { "name": "Engineering" },
//           "publish_time": 1712592000,             // unix seconds
//           "code": "A102345",                       // requisition code
//           "recruit_type": { "name": "Experienced" }
//         },
//         ...
//       ]
//     }
//   }
//
// One tenant per company; slug is `tiktok`. ByteDance's anti-bot is
// lenient on this endpoint with a polite User-Agent. The vendor
// envelope uses { code, data } shape — `code === 0` means success;
// non-zero is an API-level error and surfaces as a validation
// failure here.

const TiktokJob = z
  .object({
    id: z.union([z.string(), z.number()]).optional(),
    title: z.string().optional(),
    description: z.string().optional(),
    code: z.string().optional(),
    city_info: z.object({ name: z.string().optional() }).optional(),
    country_info: z.object({ name: z.string().optional(), code: z.string().optional() }).optional(),
    job_category: z.object({ name: z.string().optional() }).optional(),
    publish_time: z.union([z.number(), z.string()]).optional(),
    recruit_type: z.object({ name: z.string().optional() }).optional(),
    job_function: z.object({ name: z.string().optional() }).optional(),
  })
  .passthrough();

const TiktokData = z
  .object({
    count: z.number().optional(),
    job_post_list: z.array(TiktokJob).optional(),
  })
  .passthrough();

const TiktokResponse = z
  .object({
    code: z.number().optional(),
    data: TiktokData.optional(),
  })
  .passthrough();

const PAGE_SIZE = 50;
const DEFAULT_MAX_PAGES = 100; // 5,000 jobs ceiling
const TENANT_SLUG = "tiktok";

function sourceIdOf(j: z.infer<typeof TiktokJob>): string | undefined {
  const id = j.id;
  if (id === undefined) return undefined;
  return String(id);
}

function isoFromPublishTime(value: number | string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const n = typeof value === "string" ? Number.parseInt(value, 10) : value;
  if (!Number.isFinite(n) || n <= 0) return undefined;
  // Unix epoch seconds → ms
  const d = new Date(n * 1000);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

function locationOf(j: z.infer<typeof TiktokJob>): {
  text?: string;
  country?: string;
  region?: string;
} {
  const city = j.city_info?.name?.trim();
  const country_name = j.country_info?.name?.trim();
  const country_code = j.country_info?.code?.trim().toUpperCase();
  const parts = [city, country_name].filter(
    (p): p is string => typeof p === "string" && p.length > 0,
  );
  const text = parts.length > 0 ? parts.join(", ") : undefined;
  return {
    ...(text !== undefined ? { text } : {}),
    ...(country_code && /^[A-Z]{2}$/.test(country_code) ? { country: country_code } : {}),
    ...(city ? { region: city } : {}),
  };
}

function workplaceFromJob(j: z.infer<typeof TiktokJob>): Job["workplace_type"] {
  const t = j.title?.toLowerCase() ?? "";
  const c = j.city_info?.name?.toLowerCase() ?? "";
  if (/\bremote\b|\bvirtual\b/.test(`${t} ${c}`)) return "remote";
  return null;
}

export interface ParseTiktokJobsInput {
  readonly tenant: TenantInput;
  readonly company: string;
  readonly response: unknown;
  readonly observedAt: string;
}

function buildCandidate(
  raw: z.infer<typeof TiktokJob>,
  input: ParseTiktokJobsInput,
): Record<string, unknown> | null {
  const sourceId = sourceIdOf(raw);
  const title = raw.title?.trim();
  if (!sourceId || !title) return null;
  const url = `https://careers.tiktok.com/position/${encodeURIComponent(sourceId)}/detail`;
  const id = jobId({
    ats: "tiktokcareers",
    tenant_slug: input.tenant.slug,
    source_id: sourceId,
    url,
  });
  const desc = raw.description?.trim();
  const postedAt = isoFromPublishTime(raw.publish_time);
  const department = (raw.job_category?.name ?? raw.job_function?.name)?.trim();
  const loc = locationOf(raw);
  return {
    id,
    ats: "tiktokcareers",
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
 * Parse one page of careers.tiktok.com job-search JSON into Job records.
 * Pure; safe to property-test.
 */
export function parseTiktokJobs(input: ParseTiktokJobsInput): Job[] {
  const parsed = TiktokResponse.parse(input.response);
  if (parsed.code !== undefined && parsed.code !== 0) return [];
  const out: Job[] = [];
  for (const raw of parsed.data?.job_post_list ?? []) {
    const candidate = buildCandidate(raw, input);
    if (candidate === null) continue;
    const validated = JobSchema.safeParse(candidate);
    if (validated.success) out.push(validated.data);
  }
  return dedupeById(out);
}

export interface ScrapeTiktokCareersOptions {
  readonly tenant: TenantInput;
  readonly client: HttpClient;
  readonly observedAt: string;
  readonly pageSize?: number;
  readonly maxPages?: number;
}

export interface ScrapeTiktokCareersOutcome {
  readonly jobs: ReadonlyArray<Job>;
  readonly result: TenantResult;
}

export async function scrapeTiktokCareersTenant(
  opts: ScrapeTiktokCareersOptions,
): Promise<ScrapeTiktokCareersOutcome> {
  if (opts.tenant.slug !== TENANT_SLUG) {
    return {
      jobs: [],
      result: {
        slug: opts.tenant.slug,
        status: "dead",
        error: `tiktokcareers is a single-tenant ATS, slug must be "${TENANT_SLUG}"`,
        jobs_count: 0,
      },
    };
  }
  const limit = opts.pageSize ?? PAGE_SIZE;
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
  const collected: Job[] = [];
  let total = Number.POSITIVE_INFINITY;
  let lastStatus = 0;
  const company = opts.tenant.display_name ?? "TikTok";
  try {
    for (let page = 0; page < maxPages; page++) {
      const offset = page * limit;
      if (offset >= total) break;
      const res = await opts.client.request("https://careers.tiktok.com/api/v1/search/job/posts", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          keyword: "",
          limit,
          offset,
          job_category_id_list: [],
          location_code_list: [],
          subject_id_list: [],
        }),
      });
      lastStatus = res.status;
      const body = await res.json();
      const parsed = TiktokResponse.parse(body);
      if (parsed.code !== undefined && parsed.code !== 0) {
        // Vendor reported an API-level error — surface as dead via the
        // standard envelope so callers see a single error message.
        throw new Error(`tiktok api error: code=${parsed.code}`);
      }
      if (typeof parsed.data?.count === "number") total = parsed.data.count;
      const pageJobs = parseTiktokJobs({
        tenant: opts.tenant,
        company,
        response: body,
        observedAt: opts.observedAt,
      });
      for (const j of pageJobs) collected.push(j);
      const got = parsed.data?.job_post_list?.length ?? 0;
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
