import { type Job, JobSchema, type TenantInput, type TenantResult } from "@openroles/shared";
import { z } from "zod";
import { buildJob } from "../build-job.ts";
import type { HttpClient } from "../http.ts";
import { assertSafeSlug, dedupeById, errorToResult, isRecruiterTitle } from "./common.ts";

const GreenhouseLocation = z.object({ name: z.string().optional() }).optional();
const GreenhouseDepartment = z.object({ name: z.string() });
const GreenhouseOffice = z.object({ name: z.string().optional() }).optional();

const GreenhouseJob = z
  .object({
    id: z.union([z.number(), z.string()]),
    title: z.string(),
    absolute_url: z.url(),
    updated_at: z.string().optional(),
    requisition_id: z.string().optional(),
    location: GreenhouseLocation,
    departments: z.array(GreenhouseDepartment).optional(),
    offices: z.array(GreenhouseOffice).optional(),
    content: z.string().optional(),
  })
  .passthrough();

const GreenhouseResponse = z.object({
  jobs: z.array(GreenhouseJob),
});

export interface GreenhouseParseInput {
  readonly tenant: TenantInput;
  readonly company: string;
  readonly response: unknown;
  readonly observedAt: string;
}

function pickWorkplaceHint(office: string | undefined, location: string | undefined): string {
  return [office, location]
    .filter((s): s is string => typeof s === "string" && s.length > 0)
    .join(" ");
}

export function parseGreenhouseJobs(input: GreenhouseParseInput): Job[] {
  const parsed = GreenhouseResponse.parse(input.response);
  const jobs: Job[] = [];
  for (const raw of parsed.jobs) {
    const office = raw.offices?.[0]?.name;
    const location = raw.location?.name;
    const department = raw.departments?.[0]?.name;
    const candidate = buildJob({
      ats: "greenhouse",
      tenant_slug: input.tenant.slug,
      company: input.company,
      source_id: String(raw.id),
      title: raw.title,
      url: raw.absolute_url,
      ...(raw.content !== undefined ? { description_html: raw.content } : {}),
      ...(location !== undefined ? { location_text: location } : {}),
      workplace_hint: pickWorkplaceHint(office, location),
      ...(department !== undefined ? { department } : {}),
      ...(raw.updated_at !== undefined ? { updated_at: raw.updated_at } : {}),
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

export async function scrapeGreenhouseTenant(
  opts: ScrapeTenantOptions,
): Promise<ScrapeTenantOutcome> {
  try {
    assertSafeSlug(opts.tenant.slug);
    const url = `https://boards-api.greenhouse.io/v1/boards/${opts.tenant.slug}/jobs?content=true`;
    const res = await opts.client.request(url);
    const body = await res.json();
    const jobs = parseGreenhouseJobs({
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
