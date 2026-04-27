import { type Job, JobSchema, type TenantInput, type TenantResult } from "@openroles/shared";
import { z } from "zod";
import { buildJob } from "../build-job.ts";
import type { HttpClient } from "../http.ts";
import { assertSafeSlug, dedupeById, errorToResult, isRecruiterTitle } from "./common.ts";

const AshbyJob = z
  .object({
    id: z.string(),
    title: z.string(),
    departmentName: z.string().optional(),
    team: z.string().optional(),
    location: z.string().optional(),
    employmentType: z.string().optional(),
    isRemote: z.boolean().optional(),
    publishedAt: z.string().optional(),
    updatedAt: z.string().optional(),
    jobUrl: z.url(),
    applyUrl: z.url().optional(),
    descriptionHtml: z.string().optional(),
    descriptionPlain: z.string().optional(),
  })
  .passthrough();

const AshbyResponse = z.object({
  jobs: z.array(AshbyJob),
});

export interface AshbyParseInput {
  readonly tenant: TenantInput;
  readonly company: string;
  readonly response: unknown;
  readonly observedAt: string;
}

function ashbyWorkplaceHint(raw: z.infer<typeof AshbyJob>): string {
  const parts: string[] = [];
  if (raw.isRemote === true) parts.push("remote");
  if (raw.location) parts.push(raw.location);
  return parts.join(" ");
}

export function parseAshbyJobs(input: AshbyParseInput): Job[] {
  const parsed = AshbyResponse.parse(input.response);
  const jobs: Job[] = [];
  for (const raw of parsed.jobs) {
    const department = raw.departmentName ?? raw.team;
    const candidate = buildJob({
      ats: "ashby",
      tenant_slug: input.tenant.slug,
      company: input.company,
      source_id: raw.id,
      title: raw.title,
      url: raw.jobUrl,
      ...(raw.descriptionPlain !== undefined
        ? { description_text: raw.descriptionPlain }
        : raw.descriptionHtml !== undefined
          ? { description_html: raw.descriptionHtml }
          : {}),
      ...(raw.location !== undefined ? { location_text: raw.location } : {}),
      workplace_hint: ashbyWorkplaceHint(raw),
      ...(department !== undefined ? { department } : {}),
      ...(raw.publishedAt !== undefined ? { posted_at: raw.publishedAt } : {}),
      ...(raw.updatedAt !== undefined ? { updated_at: raw.updatedAt } : {}),
      is_recruiter_post: isRecruiterTitle(raw.title),
      first_seen_at: input.observedAt,
      last_seen_at: input.observedAt,
    });
    const validated = JobSchema.safeParse(candidate);
    if (validated.success) jobs.push(validated.data);
  }
  return dedupeById(jobs);
}

export interface ScrapeTenantOptions {
  readonly tenant: TenantInput;
  readonly client: HttpClient;
  readonly observedAt: string;
}

export interface ScrapeTenantOutcome {
  readonly jobs: ReadonlyArray<Job>;
  readonly result: TenantResult;
}

export async function scrapeAshbyTenant(opts: ScrapeTenantOptions): Promise<ScrapeTenantOutcome> {
  try {
    assertSafeSlug(opts.tenant.slug);
    const url = `https://api.ashbyhq.com/posting-api/job-board/${opts.tenant.slug}?includeCompensation=true`;
    const res = await opts.client.request(url);
    const body = await res.json();
    const jobs = parseAshbyJobs({
      tenant: opts.tenant,
      company: opts.tenant.display_name ?? opts.tenant.slug,
      response: body,
      observedAt: opts.observedAt,
    });
    return {
      jobs,
      result: {
        slug: opts.tenant.slug,
        status: "success",
        http_status: res.status,
        jobs_count: jobs.length,
      },
    };
  } catch (err) {
    return { jobs: [], result: errorToResult(opts.tenant.slug, err) };
  }
}
