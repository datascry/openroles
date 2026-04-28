import { type Job, JobSchema, jobId, type TenantInput, type TenantResult } from "@openroles/shared";
import type { HttpClient } from "../http.ts";
import { assertSafeSlug, dedupeById, errorToResult } from "./common.ts";

interface SmartRecruitersLocation {
  city?: string;
  country?: string;
  region?: string;
  fullLocation?: string;
  remote?: boolean;
  hybrid?: boolean;
}

interface SmartRecruitersFunction {
  label?: string;
}

interface SmartRecruitersPosting {
  id?: string;
  name?: string;
  refNumber?: string;
  releasedDate?: string;
  location?: SmartRecruitersLocation;
  department?: { label?: string };
  function?: SmartRecruitersFunction;
  experienceLevel?: { id?: string; label?: string };
}

interface SmartRecruitersResponse {
  offset?: number;
  limit?: number;
  totalFound?: number;
  content?: ReadonlyArray<SmartRecruitersPosting>;
}

const PAGE_SIZE = 100;
const MAX_PAGES = 50; // 5 000 postings ceiling

function workplaceFromLocation(loc: SmartRecruitersLocation | undefined): Job["workplace_type"] {
  if (!loc) return null;
  if (loc.remote === true) return "remote";
  if (loc.hybrid === true) return "hybrid";
  return null;
}

function isoOrUndefined(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

export interface ScrapeSmartRecruitersOptions {
  readonly tenant: TenantInput;
  readonly client: HttpClient;
  readonly observedAt: string;
}

export interface ScrapeSmartRecruitersOutcome {
  readonly jobs: ReadonlyArray<Job>;
  readonly result: TenantResult;
}

function postingToJob(
  tenantSlug: string,
  company: string,
  observedAt: string,
  p: SmartRecruitersPosting,
): Job | null {
  if (!p.id || !p.name) return null;
  const sourceId = p.id;
  // Public canonical posting URL — careers.smartrecruiters.com renders the
  // job card by id; the trailing path slug is cosmetic and ignored on read.
  const url = `https://careers.smartrecruiters.com/${tenantSlug}/${sourceId}`;
  const id = jobId({ ats: "smartrecruiters", tenant_slug: tenantSlug, source_id: sourceId, url });
  const postedAt = isoOrUndefined(p.releasedDate);
  const country = p.location?.country?.toUpperCase();
  const candidate = {
    id,
    ats: "smartrecruiters",
    tenant_slug: tenantSlug,
    source_id: sourceId,
    title: p.name,
    company,
    level: null,
    level_rank: null,
    workplace_type: workplaceFromLocation(p.location),
    is_recruiter_post: false,
    ...(p.location?.fullLocation ? { location_text: p.location.fullLocation } : {}),
    ...(country ? { location_country: country } : {}),
    ...(p.location?.city ? { location_region: p.location.city } : {}),
    ...(p.department?.label ? { department: p.department.label } : {}),
    ...(postedAt ? { posted_at: postedAt } : {}),
    first_seen_at: observedAt,
    last_seen_at: observedAt,
    url,
  };
  const validated = JobSchema.safeParse(candidate);
  return validated.success ? validated.data : null;
}

export async function scrapeSmartRecruitersTenant(
  opts: ScrapeSmartRecruitersOptions,
): Promise<ScrapeSmartRecruitersOutcome> {
  try {
    assertSafeSlug(opts.tenant.slug);
    const company = opts.tenant.display_name ?? opts.tenant.slug;
    const jobs: Job[] = [];
    let httpStatus = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      const offset = page * PAGE_SIZE;
      const url = `https://api.smartrecruiters.com/v1/companies/${opts.tenant.slug}/postings?limit=${PAGE_SIZE}&offset=${offset}`;
      // api.smartrecruiters.com/robots.txt is `Disallow: /` for everything
      // except LinkedInBot, even though /v1/companies/.../postings is the
      // documented public read-only API. Same justification as the probe's
      // skipRobots flag — treat this as an API call rather than a crawl.
      const res = await opts.client.request(url, { skipRobots: true });
      httpStatus = res.status;
      const body = (await res.json()) as SmartRecruitersResponse;
      const items = body.content ?? [];
      for (const p of items) {
        const job = postingToJob(opts.tenant.slug, company, opts.observedAt, p);
        if (job) jobs.push(job);
      }
      if (items.length < PAGE_SIZE) break;
    }
    return {
      jobs: dedupeById(jobs),
      result: {
        slug: opts.tenant.slug,
        status: "success",
        http_status: httpStatus,
        jobs_count: jobs.length,
      },
    };
  } catch (err) {
    return { jobs: [], result: errorToResult(opts.tenant.slug, err) };
  }
}
