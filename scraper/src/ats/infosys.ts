import { type Job, JobSchema, jobId, type TenantInput, type TenantResult } from "@openroles/shared";
import { z } from "zod";
import type { HttpClient } from "../http.ts";
import { dedupeById, errorToResult, isRecruiterTitle } from "./common.ts";

// Infosys public job-search API.
//
// Endpoint: https://career.infosys.com/jobsearch
// Method: GET
// Common query params:
//   page          1-indexed page number
//   size          page size
//
// Response shape (vendor stable):
//   {
//     "total": <int>,
//     "results": [
//       {
//         "jobId": "INFY-2026-12345",
//         "title": "Software Engineer",
//         "description": "...",
//         "location": "Bengaluru, India",
//         "country": "India",
//         "country_code": "IN",
//         "department": "Application Development",
//         "datePosted": "2026-04-10T00:00:00Z",
//         "url": "https://career.infosys.com/job/INFY-2026-12345"
//       },
//       ...
//     ]
//   }
//
// Single-tenant; slug = `infosys`.

const InfosysJob = z
  .object({
    jobId: z.union([z.string(), z.number()]).optional(),
    id: z.union([z.string(), z.number()]).optional(),
    title: z.string().optional(),
    description: z.string().optional(),
    location: z.string().optional(),
    country: z.string().optional(),
    country_code: z.string().optional(),
    department: z.string().optional(),
    datePosted: z.string().optional(),
    posted_date: z.string().optional(),
    url: z.string().optional(),
  })
  .passthrough();

const InfosysResponse = z
  .object({
    total: z.number().optional(),
    results: z.array(InfosysJob).optional(),
    jobs: z.array(InfosysJob).optional(),
  })
  .passthrough();

const PAGE_SIZE = 50;
const DEFAULT_MAX_PAGES = 100;
const TENANT_SLUG = "infosys";

function sourceIdOf(j: z.infer<typeof InfosysJob>): string | undefined {
  const id = j.jobId ?? j.id;
  if (id === undefined) return undefined;
  return String(id);
}

function isoOrUndefined(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

export interface ParseInfosysJobsInput {
  readonly tenant: TenantInput;
  readonly company: string;
  readonly response: unknown;
  readonly observedAt: string;
}

function buildCandidate(
  raw: z.infer<typeof InfosysJob>,
  input: ParseInfosysJobsInput,
): Record<string, unknown> | null {
  const sourceId = sourceIdOf(raw);
  const title = raw.title?.trim();
  if (!sourceId || !title) return null;
  const apiUrl = raw.url;
  const url =
    typeof apiUrl === "string" && apiUrl.startsWith("https://career.infosys.com/")
      ? apiUrl
      : `https://career.infosys.com/job/${encodeURIComponent(sourceId)}`;
  const id = jobId({
    ats: "infosys",
    tenant_slug: input.tenant.slug,
    source_id: sourceId,
    url,
  });
  const desc = raw.description?.trim();
  const postedAt = isoOrUndefined(raw.datePosted ?? raw.posted_date);
  const loc = raw.location?.trim();
  const countryCode = raw.country_code?.trim().toUpperCase();
  const department = raw.department?.trim();
  return {
    id,
    ats: "infosys",
    tenant_slug: input.tenant.slug,
    source_id: sourceId,
    title,
    company: input.company,
    ...(desc && desc.length > 0 ? { description_excerpt: desc.slice(0, 4000) } : {}),
    level: null,
    level_rank: null,
    workplace_type: /\b(?:remote|virtual|work from home)\b/i.test(`${loc} ${title}`)
      ? ("remote" as const)
      : null,
    is_recruiter_post: isRecruiterTitle(title),
    ...(loc && loc.length > 0 ? { location_text: loc } : {}),
    ...(countryCode && /^[A-Z]{2}$/.test(countryCode) ? { location_country: countryCode } : {}),
    ...(department && department.length > 0 ? { department } : {}),
    ...(postedAt !== undefined ? { posted_at: postedAt } : {}),
    first_seen_at: input.observedAt,
    last_seen_at: input.observedAt,
    url,
  };
}

/** Parse one page of Infosys career-search JSON. Pure. */
export function parseInfosysJobs(input: ParseInfosysJobsInput): Job[] {
  const parsed = InfosysResponse.parse(input.response);
  const list = parsed.results ?? parsed.jobs ?? [];
  const out: Job[] = [];
  for (const raw of list) {
    const candidate = buildCandidate(raw, input);
    if (candidate === null) continue;
    const validated = JobSchema.safeParse(candidate);
    if (validated.success) out.push(validated.data);
  }
  return dedupeById(out);
}

export interface ScrapeInfosysOptions {
  readonly tenant: TenantInput;
  readonly client: HttpClient;
  readonly observedAt: string;
  readonly pageSize?: number;
  readonly maxPages?: number;
}

export interface ScrapeInfosysOutcome {
  readonly jobs: ReadonlyArray<Job>;
  readonly result: TenantResult;
}

export async function scrapeInfosysTenant(
  opts: ScrapeInfosysOptions,
): Promise<ScrapeInfosysOutcome> {
  if (opts.tenant.slug !== TENANT_SLUG) {
    return {
      jobs: [],
      result: {
        slug: opts.tenant.slug,
        status: "dead",
        error: `infosys is a single-tenant ATS, slug must be "${TENANT_SLUG}"`,
        jobs_count: 0,
      },
    };
  }
  const limit = opts.pageSize ?? PAGE_SIZE;
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
  const collected: Job[] = [];
  let total = Number.POSITIVE_INFINITY;
  let lastStatus = 0;
  const company = opts.tenant.display_name ?? "Infosys";
  try {
    for (let page = 1; page <= maxPages; page++) {
      if ((page - 1) * limit >= total) break;
      const res = await opts.client.request(
        `https://career.infosys.com/jobsearch?page=${page}&size=${limit}`,
        { method: "GET" },
      );
      lastStatus = res.status;
      const body = await res.json();
      const parsed = InfosysResponse.parse(body);
      if (typeof parsed.total === "number") total = parsed.total;
      const pageJobs = parseInfosysJobs({
        tenant: opts.tenant,
        company,
        response: body,
        observedAt: opts.observedAt,
      });
      for (const j of pageJobs) collected.push(j);
      const got = (parsed.results ?? parsed.jobs ?? []).length;
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
