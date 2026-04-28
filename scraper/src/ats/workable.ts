import { type Job, JobSchema, jobId, type TenantInput, type TenantResult } from "@openroles/shared";
import type { HttpClient } from "../http.ts";
import { assertSafeSlug, dedupeById, errorToResult } from "./common.ts";

interface WorkableLocation {
  country?: string;
  countryCode?: string;
  city?: string;
  region?: string;
  hidden?: boolean;
}

interface WorkableJob {
  id?: string | number;
  shortcode?: string;
  title?: string;
  full_title?: string;
  url?: string;
  application_url?: string;
  shortlink?: string;
  state?: string;
  department?: string;
  // v3 (deprecated) shape
  location?: { country_code?: string; city?: string; region?: string; location_str?: string };
  // v1 widget shape
  locations?: ReadonlyArray<WorkableLocation>;
  city?: string;
  country?: string;
  country_code?: string;
  remote?: boolean;
  telecommuting?: boolean;
  workplace?: string;
  employment_type?: string;
  type?: string;
  description?: string;
  published_on?: string;
  created_at?: string;
}

interface WorkableResponse {
  // Modern v1 widget endpoint returns the account wrapper plus jobs.
  name?: string;
  description?: string;
  // Older shapes left for forward-compat in case the endpoint changes again.
  results?: ReadonlyArray<WorkableJob>;
  jobs?: ReadonlyArray<WorkableJob>;
}

function workplaceFromJob(j: WorkableJob): Job["workplace_type"] {
  if (j.remote === true || j.telecommuting === true) return "remote";
  const wp = j.workplace?.toLowerCase();
  if (wp === "remote") return "remote";
  if (wp === "hybrid") return "hybrid";
  if (wp === "on-site" || wp === "onsite") return "onsite";
  return null;
}

function isoOrUndefined(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

export interface ScrapeWorkableOptions {
  readonly tenant: TenantInput;
  readonly client: HttpClient;
  readonly observedAt: string;
}

export interface ScrapeWorkableOutcome {
  readonly jobs: ReadonlyArray<Job>;
  readonly result: TenantResult;
}

export async function scrapeWorkableTenant(
  opts: ScrapeWorkableOptions,
): Promise<ScrapeWorkableOutcome> {
  try {
    assertSafeSlug(opts.tenant.slug);
    // v1 widget endpoint — see scraper/src/harvest/probe.ts for the
    // background. v3 (`/api/v3/accounts/{slug}/jobs`) returns 404 for every
    // tenant, including known-live ones; v1 returns the canonical job set.
    const url = `https://apply.workable.com/api/v1/widget/accounts/${opts.tenant.slug}`;
    const res = await opts.client.request(url);
    const body = (await res.json()) as WorkableResponse;
    const items = body.jobs ?? body.results ?? [];
    const company = body.name ?? opts.tenant.display_name ?? opts.tenant.slug;
    const jobs: Job[] = [];
    for (const j of items) {
      const sourceId = j.shortcode ?? (j.id !== undefined ? String(j.id) : undefined);
      const title = j.title ?? j.full_title;
      if (!sourceId || !title) continue;
      const jobUrl =
        j.url ??
        j.application_url ??
        j.shortlink ??
        `https://apply.workable.com/${opts.tenant.slug}/j/${sourceId}`;
      const id = jobId({
        ats: "workable",
        tenant_slug: opts.tenant.slug,
        source_id: sourceId,
        url: jobUrl,
      });
      const postedAt = isoOrUndefined(j.published_on ?? j.created_at);
      const trimmedDesc = j.description?.trim();
      // v1 widget puts locations in `locations[0]`; v3 used a single
      // `location` object. Read from whichever is present, falling back
      // to the top-level `city` / `country_code` if neither nests.
      const firstLoc = j.locations?.[0];
      const locCity = firstLoc?.city ?? j.location?.city ?? j.city;
      const locRegion = firstLoc?.region ?? j.location?.region;
      const locCountryCode = (
        firstLoc?.countryCode ??
        j.location?.country_code ??
        j.country_code
      )?.toUpperCase();
      const locText =
        j.location?.location_str ??
        [locCity, locRegion, firstLoc?.country].filter(Boolean).join(", ");
      const candidate = {
        id,
        ats: "workable",
        tenant_slug: opts.tenant.slug,
        source_id: sourceId,
        title,
        company,
        ...(trimmedDesc ? { description_excerpt: trimmedDesc.slice(0, 4000) } : {}),
        level: null,
        level_rank: null,
        workplace_type: workplaceFromJob(j),
        is_recruiter_post: false,
        ...(locText.length > 0 ? { location_text: locText } : {}),
        ...(locCountryCode && /^[A-Z]{2}$/.test(locCountryCode)
          ? { location_country: locCountryCode }
          : {}),
        ...(locCity ? { location_region: locCity } : {}),
        ...(j.department ? { department: j.department } : {}),
        ...(postedAt ? { posted_at: postedAt } : {}),
        first_seen_at: opts.observedAt,
        last_seen_at: opts.observedAt,
        url: jobUrl,
      };
      const validated = JobSchema.safeParse(candidate);
      if (validated.success) jobs.push(validated.data);
    }
    return {
      jobs: dedupeById(jobs),
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
