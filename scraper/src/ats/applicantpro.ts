import { type Job, JobSchema, type TenantInput, type TenantResult } from "@openroles/shared";
import { buildJob } from "../build-job.ts";
import type { HttpClient } from "../http.ts";
import { assertSafeSlug, dedupeById, errorToResult } from "./common.ts";

// ApplicantPro renders the public careers page through a Vue app that loads
// jobs via an undocumented JSON endpoint at
// `https://{slug}.applicantpro.com/core/jobs/{domainId}?getParams=%7B%7D`.
// The `domainId` is per-tenant and embedded in the listing HTML as
// `courierCurrentRouteData = {"domain_id":"17874",...}`. Each entry returned
// by the endpoint carries title, location (city / stateName / iso3),
// workplaceType (Onsite / Hybrid / Remote), employmentType, salary range,
// and a canonical jobUrl — but no description. Description would require a
// per-job HTML fetch and isn't worth the request multiplication at scale.

interface ApplicantProJob {
  id?: number | string;
  title?: string;
  city?: string;
  stateName?: string;
  iso3?: string;
  abbreviation?: string;
  jobLocation?: string;
  workplaceType?: string;
  employmentType?: string;
  jobCategory?: string | null;
  payRate?: string;
  minSalary?: string;
  maxSalary?: string;
  payType?: string;
  jobUrl?: string;
}

interface ApplicantProResponse {
  success?: boolean;
  data?: {
    jobs?: ReadonlyArray<ApplicantProJob>;
  };
}

const DOMAIN_ID_RE = /["']domain_id["']\s*:\s*["'](\d{1,12})["']/;

function extractDomainId(html: string): string | undefined {
  const m = DOMAIN_ID_RE.exec(html);
  return m?.[1];
}

function workplaceFrom(value: string | undefined): Job["workplace_type"] {
  switch (value?.toLowerCase()) {
    case "remote":
      return "remote";
    case "hybrid":
      return "hybrid";
    case "onsite":
    case "on-site":
    case "office":
      return "onsite";
    default:
      return null;
  }
}

const ISO3_TO_ISO2: Record<string, string> = {
  USA: "US",
  CAN: "CA",
  GBR: "GB",
  DEU: "DE",
  FRA: "FR",
  ESP: "ES",
  ITA: "IT",
  IRL: "IE",
  AUS: "AU",
  NZL: "NZ",
  IND: "IN",
  JPN: "JP",
  CHN: "CN",
  MEX: "MX",
  BRA: "BR",
  ARG: "AR",
  NLD: "NL",
  BEL: "BE",
  CHE: "CH",
  AUT: "AT",
  SWE: "SE",
  NOR: "NO",
  DNK: "DK",
  FIN: "FI",
  POL: "PL",
  PRT: "PT",
};

function locationCountry(
  iso3: string | undefined,
  abbreviation: string | undefined,
): string | undefined {
  if (typeof iso3 === "string" && ISO3_TO_ISO2[iso3]) return ISO3_TO_ISO2[iso3];
  if (typeof abbreviation === "string" && /^[A-Z]{2}$/.test(abbreviation)) return abbreviation;
  return undefined;
}

function parseMoney(value: string | undefined): number | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const n = Number.parseFloat(value);
  // JobSchema expects compensation as an integer. ApplicantPro often returns
  // hourly rates like "21.5" — rounding to the nearest whole unit keeps the
  // signal (sortable, comparable) without inventing precision.
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.round(n);
}

export interface ScrapeApplicantProOptions {
  readonly tenant: TenantInput;
  readonly client: HttpClient;
  readonly observedAt: string;
}

export interface ScrapeApplicantProOutcome {
  readonly jobs: ReadonlyArray<Job>;
  readonly result: TenantResult;
}

export async function scrapeApplicantProTenant(
  opts: ScrapeApplicantProOptions,
): Promise<ScrapeApplicantProOutcome> {
  try {
    assertSafeSlug(opts.tenant.slug);
    // Step 1: fetch the listing HTML to discover the per-tenant domain_id.
    const listingUrl = `https://${opts.tenant.slug}.applicantpro.com/jobs/`;
    const listingRes = await opts.client.request(listingUrl);
    const listingHtml = await listingRes.text();
    const domainId = extractDomainId(listingHtml);
    if (!domainId) {
      // Tenant exists (page returned 2xx) but has no public job listings —
      // many tenant slugs from the harvester resolve to a generic landing
      // page with no JobListings component mounted. Treat as success with
      // zero jobs, mirroring the breezy "empty positions" behavior.
      return {
        jobs: [],
        result: {
          slug: opts.tenant.slug,
          status: "success",
          http_status: listingRes.status,
          jobs_count: 0,
        },
      };
    }
    // Step 2: hit the JSON endpoint. `getParams` is JSON-encoded; the empty
    // object asks for the unfiltered job list.
    const apiUrl = `https://${opts.tenant.slug}.applicantpro.com/core/jobs/${domainId}?getParams=%7B%7D`;
    const apiRes = await opts.client.request(apiUrl);
    const body = (await apiRes.json()) as ApplicantProResponse;
    const items = body.data?.jobs ?? [];
    const company = opts.tenant.display_name ?? opts.tenant.slug;
    const jobs: Job[] = [];
    for (const item of items) {
      if (item.id === undefined || !item.title || !item.jobUrl) continue;
      const sourceId = String(item.id);
      const cMin = parseMoney(item.minSalary);
      const cMax = parseMoney(item.maxSalary);
      const candidate = buildJob({
        ats: "applicantpro",
        tenant_slug: opts.tenant.slug,
        company,
        source_id: sourceId,
        title: item.title,
        url: item.jobUrl,
        ...(item.jobLocation
          ? { location_text: item.jobLocation }
          : item.city
            ? { location_text: [item.city, item.stateName].filter(Boolean).join(", ") }
            : {}),
        workplace_hint: item.workplaceType ?? "",
        ...(item.employmentType ? { department: item.employmentType } : {}),
        is_recruiter_post: false,
        first_seen_at: opts.observedAt,
        last_seen_at: opts.observedAt,
        ...(cMin !== undefined ? { compensation_min: cMin } : {}),
        ...(cMax !== undefined ? { compensation_max: cMax } : {}),
      });
      // Apply structured workplace + region/country directly (buildJob's
      // string-hint inference doesn't always pick the right canonical form).
      const country = locationCountry(item.iso3, item.abbreviation);
      const region = item.stateName;
      const enriched: Job = {
        ...candidate,
        workplace_type: workplaceFrom(item.workplaceType) ?? candidate.workplace_type,
        ...(country ? { location_country: country } : {}),
        ...(region ? { location_region: region } : {}),
      };
      const validated = JobSchema.safeParse(enriched);
      if (validated.success) jobs.push(validated.data);
    }
    return {
      jobs: dedupeById(jobs),
      result: {
        slug: opts.tenant.slug,
        status: "success",
        http_status: apiRes.status,
        jobs_count: jobs.length,
      },
    };
  } catch (err) {
    return { jobs: [], result: errorToResult(opts.tenant.slug, err) };
  }
}
