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

const GreenhouseLocation = z.object({ name: z.string().nullish() }).nullish();
const GreenhouseDepartment = z.object({ name: z.string() });
const GreenhouseOffice = z.object({ name: z.string().nullish() }).nullish();

// Greenhouse can return `null` for any optional string (e.g. `requisition_id`
// is null on tenants that don't track requisitions). `.nullish()` accepts
// both null and missing.
const GreenhouseJob = z
  .object({
    id: z.union([z.number(), z.string()]),
    title: z.string(),
    absolute_url: z.url(),
    updated_at: z.string().nullish(),
    requisition_id: z.string().nullish(),
    location: GreenhouseLocation,
    departments: z.array(GreenhouseDepartment).nullish(),
    offices: z.array(GreenhouseOffice).nullish(),
    content: z.string().nullish(),
  })
  .passthrough();

const GreenhouseResponse = z.object({
  jobs: z.array(z.unknown()),
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

function nonEmpty(value: string | null | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function parseGreenhouseJobs(input: GreenhouseParseInput): Job[] {
  const envelope = GreenhouseResponse.safeParse(input.response);
  if (!envelope.success) return [];
  const jobs: Job[] = [];
  for (const item of envelope.data.jobs) {
    // Per-job parse so one malformed posting cannot dead-letter the whole
    // tenant — common when greenhouse adds a new optional field.
    const parsed = GreenhouseJob.safeParse(item);
    if (!parsed.success) continue;
    const raw = parsed.data;
    const office = nonEmpty(raw.offices?.[0]?.name);
    const location = nonEmpty(raw.location?.name);
    const department = nonEmpty(raw.departments?.[0]?.name);
    const description = nonEmpty(raw.content);
    // Greenhouse returns updated_at with a numeric timezone offset
    // (`2026-03-11T17:29:19-04:00`); JobSchema requires Z-suffixed UTC.
    const updatedAt = vendorDateToIsoZ(raw.updated_at);
    const candidate = buildJob({
      ats: "greenhouse",
      tenant_slug: input.tenant.slug,
      company: input.company,
      source_id: String(raw.id),
      title: raw.title,
      url: raw.absolute_url,
      ...(description !== undefined ? { description_html: description } : {}),
      ...(location !== undefined ? { location_text: location } : {}),
      workplace_hint: pickWorkplaceHint(office, location),
      ...(department !== undefined ? { department } : {}),
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
