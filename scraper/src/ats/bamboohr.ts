import { type Job, JobSchema, type TenantInput, type TenantResult } from "@openroles/shared";
import { z } from "zod";
import { buildJob } from "../build-job.ts";
import type { HttpClient } from "../http.ts";
import { assertSafeSlug, dedupeById, errorToResult, isRecruiterTitle } from "./common.ts";

const BambooJob = z
  .object({
    id: z.union([z.string(), z.number()]),
    jobOpeningName: z.string(),
    departmentLabel: z.string().optional(),
    employmentStatusLabel: z.string().optional(),
    locationCity: z.string().optional(),
    locationState: z.string().optional(),
    locationCountry: z.string().optional(),
    isRemote: z.union([z.string(), z.boolean()]).optional(),
    datePosted: z.string().optional(),
    description: z.string().optional(),
    jobUrl: z.string().optional(),
  })
  .passthrough();

const BambooResponse = z.object({
  result: z.array(BambooJob),
});

export interface BambooParseInput {
  readonly tenant: TenantInput;
  readonly company: string;
  readonly response: unknown;
  readonly observedAt: string;
}

const COUNTRY_NAME_TO_CODE: Record<string, string> = {
  "united states": "US",
  "united states of america": "US",
  usa: "US",
  "united kingdom": "GB",
  uk: "GB",
  canada: "CA",
  germany: "DE",
  france: "FR",
  japan: "JP",
  india: "IN",
  australia: "AU",
};

function bambooLocationText(raw: z.infer<typeof BambooJob>): string | undefined {
  const parts = [raw.locationCity, raw.locationState, raw.locationCountry].filter(
    (s): s is string => typeof s === "string" && s.length > 0,
  );
  return parts.length > 0 ? parts.join(", ") : undefined;
}

function bambooCountryCode(name: string | undefined): string | undefined {
  if (!name) return undefined;
  if (/^[A-Z]{2}$/.test(name)) return name;
  return COUNTRY_NAME_TO_CODE[name.toLowerCase()];
}

function isRemoteFlag(value: string | boolean | undefined): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return /^(yes|true|1)$/i.test(value);
  return false;
}

function dateToIso(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (/^\d{4}-\d{2}-\d{2}T/.test(value)) return value;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return `${value}T00:00:00Z`;
  return undefined;
}

function bambooJobUrl(slug: string, raw: z.infer<typeof BambooJob>): string {
  if (raw.jobUrl !== undefined) return raw.jobUrl;
  return `https://${slug}.bamboohr.com/careers/${encodeURIComponent(String(raw.id))}`;
}

export function parseBambooJobs(input: BambooParseInput): Job[] {
  const parsed = BambooResponse.parse(input.response);
  const jobs: Job[] = [];
  for (const raw of parsed.result) {
    const locationText = bambooLocationText(raw);
    const country = bambooCountryCode(raw.locationCountry);
    const remote = isRemoteFlag(raw.isRemote);
    const workplaceHint = [
      remote ? "remote" : "",
      locationText ?? "",
      raw.employmentStatusLabel ?? "",
    ]
      .filter((s) => s.length > 0)
      .join(" ");
    const candidate = buildJob({
      ats: "bamboohr",
      tenant_slug: input.tenant.slug,
      company: input.company,
      source_id: String(raw.id),
      title: raw.jobOpeningName,
      url: bambooJobUrl(input.tenant.slug, raw),
      ...(raw.description !== undefined ? { description_html: raw.description } : {}),
      ...(locationText !== undefined ? { location_text: locationText } : {}),
      workplace_hint: workplaceHint,
      ...(raw.departmentLabel !== undefined ? { department: raw.departmentLabel } : {}),
      ...(dateToIso(raw.datePosted) !== undefined
        ? { posted_at: dateToIso(raw.datePosted) as string }
        : {}),
      is_recruiter_post: isRecruiterTitle(raw.jobOpeningName),
      first_seen_at: input.observedAt,
      last_seen_at: input.observedAt,
    });
    const candidateWithCountry =
      country !== undefined ? { ...candidate, location_country: country } : candidate;
    const validated = JobSchema.safeParse(candidateWithCountry);
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

export async function scrapeBambooTenant(opts: ScrapeTenantOptions): Promise<ScrapeTenantOutcome> {
  try {
    assertSafeSlug(opts.tenant.slug);
    const url = `https://${opts.tenant.slug}.bamboohr.com/careers/list`;
    const res = await opts.client.request(url, {
      headers: { accept: "application/json" },
    });
    const body = await res.json();
    const jobs = parseBambooJobs({
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
