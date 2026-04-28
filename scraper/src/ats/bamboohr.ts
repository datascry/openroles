import { type Job, JobSchema, type TenantInput, type TenantResult } from "@openroles/shared";
import { z } from "zod";
import { buildJob } from "../build-job.ts";
import type { HttpClient } from "../http.ts";
import { assertSafeSlug, dedupeById, errorToResult, isRecruiterTitle } from "./common.ts";

// BambooHR's `careers/list` endpoint returns each job in this shape.
// Optional fields can come back as `null` rather than missing — `.nullish()`
// covers both. The location moved from flat `locationCity/State/Country`
// fields to nested `location` (city/state) and `atsLocation` (country/city/
// state/province) objects; the legacy flat fields are kept on the schema in
// case some older tenants still return them, but every fresh capture we have
// uses the nested shape exclusively.
const NestedLocation = z
  .object({
    city: z.string().nullish(),
    state: z.string().nullish(),
  })
  .nullish();
const AtsLocation = z
  .object({
    country: z.string().nullish(),
    state: z.string().nullish(),
    province: z.string().nullish(),
    city: z.string().nullish(),
  })
  .nullish();

const BambooJob = z
  .object({
    id: z.union([z.string(), z.number()]),
    jobOpeningName: z.string(),
    departmentLabel: z.string().nullish(),
    employmentStatusLabel: z.string().nullish(),
    location: NestedLocation,
    atsLocation: AtsLocation,
    locationCity: z.string().nullish(),
    locationState: z.string().nullish(),
    locationCountry: z.string().nullish(),
    // BambooHR encodes workplace as `locationType`: "0" onsite, "1" remote,
    // "2" hybrid. The legacy `isRemote` boolean still appears (often null).
    locationType: z.string().nullish(),
    isRemote: z.union([z.string(), z.boolean()]).nullish(),
    datePosted: z.string().nullish(),
    description: z.string().nullish(),
    jobUrl: z.string().nullish(),
  })
  .passthrough();

const BambooResponse = z.object({
  result: z.array(z.unknown()),
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

function nonEmpty(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function bambooLocationText(raw: z.infer<typeof BambooJob>): string | undefined {
  const city =
    nonEmpty(raw.location?.city) ?? nonEmpty(raw.atsLocation?.city) ?? nonEmpty(raw.locationCity);
  const region =
    nonEmpty(raw.location?.state) ??
    nonEmpty(raw.atsLocation?.state) ??
    nonEmpty(raw.atsLocation?.province) ??
    nonEmpty(raw.locationState);
  const country = nonEmpty(raw.atsLocation?.country) ?? nonEmpty(raw.locationCountry);
  const parts = [city, region, country].filter((s): s is string => s !== undefined);
  return parts.length > 0 ? parts.join(", ") : undefined;
}

function bambooCountryCode(raw: z.infer<typeof BambooJob>): string | undefined {
  const name = nonEmpty(raw.atsLocation?.country) ?? nonEmpty(raw.locationCountry);
  if (!name) return undefined;
  if (/^[A-Z]{2}$/.test(name)) return name;
  return COUNTRY_NAME_TO_CODE[name.toLowerCase()];
}

function isRemoteFlag(value: string | boolean | null | undefined): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return /^(yes|true|1)$/i.test(value);
  return false;
}

function workplaceHintFor(raw: z.infer<typeof BambooJob>): string | undefined {
  switch (nonEmpty(raw.locationType)) {
    case "1":
      return "remote";
    case "2":
      return "hybrid";
    case "0":
      return "onsite";
    default:
      return undefined;
  }
}

function dateToIso(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  if (/^\d{4}-\d{2}-\d{2}T/.test(value)) return value;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return `${value}T00:00:00Z`;
  return undefined;
}

function bambooJobUrl(slug: string, raw: z.infer<typeof BambooJob>): string {
  const url = nonEmpty(raw.jobUrl);
  if (url) return url;
  return `https://${slug}.bamboohr.com/careers/${encodeURIComponent(String(raw.id))}`;
}

export function parseBambooJobs(input: BambooParseInput): Job[] {
  const envelope = BambooResponse.safeParse(input.response);
  if (!envelope.success) return [];
  const jobs: Job[] = [];
  for (const item of envelope.data.result) {
    // Per-job parsing — one malformed posting must not poison the rest of
    // the tenant's response. (BambooHR has rolled the response shape twice
    // since this scraper was first written; tolerance here keeps the
    // scraper running through the next change.)
    const parsed = BambooJob.safeParse(item);
    if (!parsed.success) continue;
    const raw = parsed.data;
    const locationText = bambooLocationText(raw);
    const country = bambooCountryCode(raw);
    const remoteFromFlag = isRemoteFlag(raw.isRemote);
    const workplaceFromType = workplaceHintFor(raw);
    const workplaceHint =
      workplaceFromType ??
      [
        remoteFromFlag ? "remote" : "",
        locationText ?? "",
        nonEmpty(raw.employmentStatusLabel) ?? "",
      ]
        .filter((s) => s.length > 0)
        .join(" ");
    const description = nonEmpty(raw.description);
    const department = nonEmpty(raw.departmentLabel);
    const posted = dateToIso(raw.datePosted);
    const candidate = buildJob({
      ats: "bamboohr",
      tenant_slug: input.tenant.slug,
      company: input.company,
      source_id: String(raw.id),
      title: raw.jobOpeningName,
      url: bambooJobUrl(input.tenant.slug, raw),
      ...(description !== undefined ? { description_html: description } : {}),
      ...(locationText !== undefined ? { location_text: locationText } : {}),
      workplace_hint: workplaceHint,
      ...(department !== undefined ? { department } : {}),
      ...(posted !== undefined ? { posted_at: posted } : {}),
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
