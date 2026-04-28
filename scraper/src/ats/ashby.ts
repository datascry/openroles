import { type Job, JobSchema, type TenantInput, type TenantResult } from "@openroles/shared";
import { z } from "zod";
import { buildJob } from "../build-job.ts";
import type { HttpClient } from "../http.ts";
import {
  assertSafeSlug,
  dedupeById,
  errorToResult,
  isRecruiterTitle,
  vendorDateToIsoZ,
} from "./common.ts";

// Ashby sends nulls (rather than absent fields) for isRemote, updatedAt, etc.
// Optional fields use `.nullish()` so the parse succeeds; consumer code
// treats null as undefined.
const AshbyJob = z
  .object({
    id: z.string(),
    title: z.string(),
    departmentName: z.string().nullish(),
    team: z.string().nullish(),
    location: z.string().nullish(),
    employmentType: z.string().nullish(),
    isRemote: z.boolean().nullish(),
    publishedAt: z.string().nullish(),
    updatedAt: z.string().nullish(),
    jobUrl: z.url(),
    applyUrl: z.url().nullish(),
    descriptionHtml: z.string().nullish(),
    descriptionPlain: z.string().nullish(),
  })
  .passthrough();

const AshbyResponse = z.object({
  jobs: z.array(z.unknown()),
});

export interface AshbyParseInput {
  readonly tenant: TenantInput;
  readonly company: string;
  readonly response: unknown;
  readonly observedAt: string;
}

function nonEmpty(value: string | null | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function ashbyWorkplaceHint(raw: z.infer<typeof AshbyJob>): string {
  const parts: string[] = [];
  if (raw.isRemote === true) parts.push("remote");
  const location = nonEmpty(raw.location);
  if (location) parts.push(location);
  return parts.join(" ");
}

export function parseAshbyJobs(input: AshbyParseInput): Job[] {
  const envelope = AshbyResponse.safeParse(input.response);
  if (!envelope.success) return [];
  const jobs: Job[] = [];
  for (const item of envelope.data.jobs) {
    // Per-job parse so one malformed posting does not poison the rest.
    const parsed = AshbyJob.safeParse(item);
    if (!parsed.success) continue;
    const raw = parsed.data;
    const department = nonEmpty(raw.departmentName) ?? nonEmpty(raw.team);
    const description = nonEmpty(raw.descriptionPlain);
    const descriptionHtml = nonEmpty(raw.descriptionHtml);
    const location = nonEmpty(raw.location);
    // Ashby publishedAt comes back as `2025-11-17T14:04:36.867+00:00`;
    // JobSchema requires Z-suffixed UTC.
    const postedAt = vendorDateToIsoZ(raw.publishedAt);
    const updatedAt = vendorDateToIsoZ(raw.updatedAt);
    const candidate = buildJob({
      ats: "ashby",
      tenant_slug: input.tenant.slug,
      company: input.company,
      source_id: raw.id,
      title: raw.title,
      url: raw.jobUrl,
      ...(description !== undefined
        ? { description_text: description }
        : descriptionHtml !== undefined
          ? { description_html: descriptionHtml }
          : {}),
      ...(location !== undefined ? { location_text: location } : {}),
      workplace_hint: ashbyWorkplaceHint(raw),
      ...(department !== undefined ? { department } : {}),
      ...(postedAt !== undefined ? { posted_at: postedAt } : {}),
      ...(updatedAt !== undefined ? { updated_at: updatedAt } : {}),
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
