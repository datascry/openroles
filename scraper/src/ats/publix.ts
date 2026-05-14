import { type Job, JobSchema, jobId, type TenantInput, type TenantResult } from "@openroles/shared";
import { z } from "zod";
import type { HttpClient } from "../http.ts";
import { dedupeById, errorToResult, isRecruiterTitle } from "./common.ts";

// Publix public job-search endpoint.
//
// Endpoint: https://corporate.publix.com/api/careers/jobs
// Method: GET
// Query: page, size
//
// Response shape (vendor stable):
//   { total: <int>, jobs: [{ jobId, title, location, postedDate, description, url }] }
//
// Single-tenant; slug = `publix`. Small board (typically 50-200
// open positions across all stores), so a single-page sweep usually
// covers the entire roster.

const PublixJob = z
  .object({
    jobId: z.union([z.string(), z.number()]).optional(),
    id: z.union([z.string(), z.number()]).optional(),
    title: z.string().optional(),
    description: z.string().optional(),
    location: z.string().optional(),
    country_code: z.string().optional(),
    department: z.string().optional(),
    postedDate: z.string().optional(),
    posted_date: z.string().optional(),
    url: z.string().optional(),
  })
  .passthrough();

const PublixResponse = z
  .object({
    total: z.number().optional(),
    jobs: z.array(PublixJob).optional(),
    results: z.array(PublixJob).optional(),
  })
  .passthrough();

const PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 10;
const TENANT_SLUG = "publix";
const HOST = "corporate.publix.com";

function isoOrUndefined(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

export interface ParsePublixJobsInput {
  readonly tenant: TenantInput;
  readonly company: string;
  readonly response: unknown;
  readonly observedAt: string;
}

function buildCandidate(
  raw: z.infer<typeof PublixJob>,
  input: ParsePublixJobsInput,
): Record<string, unknown> | null {
  const id = raw.jobId ?? raw.id;
  const sourceId = id === undefined ? undefined : String(id);
  const title = raw.title?.trim();
  if (!sourceId || !title) return null;
  const apiUrl = raw.url;
  const url =
    typeof apiUrl === "string" && apiUrl.startsWith(`https://${HOST}/`)
      ? apiUrl
      : `https://${HOST}/careers/job/${encodeURIComponent(sourceId)}`;
  const jid = jobId({ ats: "publix", tenant_slug: input.tenant.slug, source_id: sourceId, url });
  const desc = raw.description?.trim();
  const postedAt = isoOrUndefined(raw.postedDate ?? raw.posted_date);
  const loc = raw.location?.trim();
  const countryCode = raw.country_code?.trim().toUpperCase();
  const department = raw.department?.trim();
  return {
    id: jid,
    ats: "publix",
    tenant_slug: input.tenant.slug,
    source_id: sourceId,
    title,
    company: input.company,
    ...(desc && desc.length > 0 ? { description_excerpt: desc.slice(0, 4000) } : {}),
    level: null,
    level_rank: null,
    workplace_type: /\bremote\b/i.test(`${loc} ${title}`) ? ("remote" as const) : null,
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

export function parsePublixJobs(input: ParsePublixJobsInput): Job[] {
  const parsed = PublixResponse.parse(input.response);
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

export interface ScrapePublixOptions {
  readonly tenant: TenantInput;
  readonly client: HttpClient;
  readonly observedAt: string;
  readonly pageSize?: number;
  readonly maxPages?: number;
}

export interface ScrapePublixOutcome {
  readonly jobs: ReadonlyArray<Job>;
  readonly result: TenantResult;
}

export async function scrapePublixTenant(opts: ScrapePublixOptions): Promise<ScrapePublixOutcome> {
  if (opts.tenant.slug !== TENANT_SLUG) {
    return {
      jobs: [],
      result: {
        slug: opts.tenant.slug,
        status: "dead",
        error: `publix is a single-tenant ATS, slug must be "${TENANT_SLUG}"`,
        jobs_count: 0,
      },
    };
  }
  const limit = opts.pageSize ?? PAGE_SIZE;
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
  const collected: Job[] = [];
  let total = Number.POSITIVE_INFINITY;
  let lastStatus = 0;
  const company = opts.tenant.display_name ?? "Publix";
  try {
    for (let page = 1; page <= maxPages; page++) {
      if ((page - 1) * limit >= total) break;
      const res = await opts.client.request(
        `https://${HOST}/api/careers/jobs?page=${page}&size=${limit}`,
        { method: "GET" },
      );
      lastStatus = res.status;
      const body = await res.json();
      const parsed = PublixResponse.parse(body);
      if (typeof parsed.total === "number") total = parsed.total;
      const pageJobs = parsePublixJobs({
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
