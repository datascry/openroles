import { type Job, JobSchema, type TenantInput, type TenantResult } from "@openroles/shared";
import { z } from "zod";
import { buildJob } from "../build-job.ts";
import type { HttpClient } from "../http.ts";
import {
  assertSafeSlug,
  assertWorkdayHost,
  assertWorkdaySite,
  dedupeById,
  errorToResult,
  isRecruiterTitle,
} from "./common.ts";

const WorkdayJobPosting = z
  .object({
    title: z.string(),
    externalPath: z.string(),
    locationsText: z.string().optional(),
    postedOn: z.string().optional(),
    bulletFields: z.array(z.string()).optional(),
    jobReqId: z.string().optional(),
    jobFamily: z.string().optional(),
  })
  .passthrough();

const WorkdayResponse = z.object({
  total: z.number(),
  jobPostings: z.array(WorkdayJobPosting),
});

export interface WorkdayParseInput {
  readonly tenant: TenantInput;
  readonly company: string;
  readonly host: string;
  readonly response: unknown;
  readonly observedAt: string;
}

function workdayJobUrl(host: string, externalPath: string): string {
  const path = externalPath.startsWith("/") ? externalPath : `/${externalPath}`;
  return `https://${host}${path}`;
}

function workdaySourceId(externalPath: string, jobReqId: string | undefined): string {
  if (jobReqId !== undefined && jobReqId.length > 0) return jobReqId;
  const parts = externalPath.split("/");
  return parts[parts.length - 1] ?? externalPath;
}

export function parseWorkdayJobs(input: WorkdayParseInput): Job[] {
  const parsed = WorkdayResponse.parse(input.response);
  const jobs: Job[] = [];
  for (const raw of parsed.jobPostings) {
    const candidate = buildJob({
      ats: "workday",
      tenant_slug: input.tenant.slug,
      company: input.company,
      source_id: workdaySourceId(raw.externalPath, raw.jobReqId),
      title: raw.title,
      url: workdayJobUrl(input.host, raw.externalPath),
      ...(raw.locationsText !== undefined ? { location_text: raw.locationsText } : {}),
      workplace_hint: raw.locationsText ?? "",
      ...(raw.jobFamily !== undefined ? { department: raw.jobFamily } : {}),
      is_recruiter_post: isRecruiterTitle(raw.title),
      first_seen_at: input.observedAt,
      last_seen_at: input.observedAt,
    });
    const validated = JobSchema.safeParse(candidate);
    if (validated.success) jobs.push(validated.data);
  }
  return dedupeById(jobs);
}

export interface ScrapeWorkdayOptions {
  readonly tenant: TenantInput;
  readonly client: HttpClient;
  readonly observedAt: string;
  readonly host: string;
  readonly site: string;
  readonly pageSize?: number;
  readonly maxPages?: number;
}

export interface ScrapeTenantOutcome {
  readonly jobs: ReadonlyArray<Job>;
  readonly result: TenantResult;
}

const DEFAULT_PAGE_SIZE = 20;
const DEFAULT_MAX_PAGES = 200;

export async function scrapeWorkdayTenant(
  opts: ScrapeWorkdayOptions,
): Promise<ScrapeTenantOutcome> {
  const limit = opts.pageSize ?? DEFAULT_PAGE_SIZE;
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
  const collected: Job[] = [];
  let total = Number.POSITIVE_INFINITY;
  let lastStatus = 0;
  try {
    assertSafeSlug(opts.tenant.slug);
    assertWorkdayHost(opts.host);
    assertWorkdaySite(opts.site);
    const url = `https://${opts.host}/wday/cxs/${opts.tenant.slug}/${opts.site}/jobs`;
    for (let page = 0; page < maxPages; page++) {
      const offset = page * limit;
      if (offset >= total) break;
      const res = await opts.client.request(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          appliedFacets: {},
          limit,
          offset,
          searchText: "",
        }),
      });
      lastStatus = res.status;
      const body = await res.json();
      const parsed = WorkdayResponse.parse(body);
      total = parsed.total;
      const pageJobs = parseWorkdayJobs({
        tenant: opts.tenant,
        company: opts.tenant.display_name ?? opts.tenant.slug,
        host: opts.host,
        response: body,
        observedAt: opts.observedAt,
      });
      for (const j of pageJobs) collected.push(j);
      if (parsed.jobPostings.length < limit) break;
    }
    const jobs = dedupeById(collected);
    return {
      jobs,
      result: {
        slug: opts.tenant.slug,
        status: "success",
        http_status: lastStatus,
        jobs_count: jobs.length,
      },
    };
  } catch (err) {
    return { jobs: [], result: errorToResult(opts.tenant.slug, err) };
  }
}
