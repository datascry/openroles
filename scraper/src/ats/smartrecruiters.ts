import { type Job, JobSchema, jobId, type TenantInput, type TenantResult } from "@openroles/shared";
import pLimit from "p-limit";
import type { HttpClient } from "../http.ts";
import { excerpt, plainText } from "../normalize.ts";
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

interface SmartRecruitersJobAdSection {
  title?: string;
  text?: string;
}

interface SmartRecruitersJobAd {
  sections?: {
    companyDescription?: SmartRecruitersJobAdSection;
    jobDescription?: SmartRecruitersJobAdSection;
    qualifications?: SmartRecruitersJobAdSection;
    additionalInformation?: SmartRecruitersJobAdSection;
  };
}

interface SmartRecruitersPostingDetail extends SmartRecruitersPosting {
  jobAd?: SmartRecruitersJobAd;
}

const PAGE_SIZE = 100;
const MAX_PAGES = 50; // 5 000 postings ceiling
const DEFAULT_DETAIL_CONCURRENCY = 8;
// Bound the per-tenant detail fan-out so a single mega-tenant (e.g. bosch
// with ~4 500 postings) cannot blow the matrix job's 45-minute budget.
// At ~735 ms / detail and concurrency = 8, 200 fetches finishes in ~18 s;
// raising it past this would push the slow tail of large tenants over the
// runner timeout, sacrificing the overall daily refresh for marginal
// description coverage on the oldest postings of a few employers.
const MAX_DETAIL_FETCH_PER_TENANT = 200;

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
  readonly perTenantConcurrency?: number;
}

export interface ScrapeSmartRecruitersOutcome {
  readonly jobs: ReadonlyArray<Job>;
  readonly result: TenantResult;
}

function descriptionFromJobAd(ad: SmartRecruitersJobAd | undefined): string | undefined {
  if (!ad?.sections) return undefined;
  // Concatenate the four sections in their natural reading order (job
  // description first, then qualifications, then additional info, then the
  // boilerplate company blurb) so FTS hits the role-specific text first.
  const parts = [
    ad.sections.jobDescription?.text,
    ad.sections.qualifications?.text,
    ad.sections.additionalInformation?.text,
    ad.sections.companyDescription?.text,
  ].filter((s): s is string => typeof s === "string" && s.trim().length > 0);
  if (parts.length === 0) return undefined;
  const text = plainText(parts.join("\n\n"));
  return text.length > 0 ? excerpt(text) : undefined;
}

function postingToJob(
  tenantSlug: string,
  company: string,
  observedAt: string,
  p: SmartRecruitersPosting,
  detail: SmartRecruitersPostingDetail | undefined,
): Job | null {
  if (!p.id || !p.name) return null;
  const sourceId = p.id;
  // Public canonical posting URL. The per-posting host
  // `jobs.smartrecruiters.com/{tenant}/{id}` renders the job card directly
  // (200, no redirect) and accepts the id with no trailing title slug. The
  // company-branded `careers.smartrecruiters.com/{tenant}` host is a listing
  // page only: a `/{tenant}/{id}` deep link there 302-redirects to the bare
  // `/{tenant}` listing, dropping the posting entirely (verified live across
  // multiple tenants, 2026-06-05).
  const url = `https://jobs.smartrecruiters.com/${tenantSlug}/${sourceId}`;
  const id = jobId({ ats: "smartrecruiters", tenant_slug: tenantSlug, source_id: sourceId, url });
  const postedAt = isoOrUndefined(p.releasedDate);
  const country = p.location?.country?.toUpperCase();
  const description = descriptionFromJobAd(detail?.jobAd);
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
    ...(description ? { description_excerpt: description } : {}),
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
    const postings: SmartRecruitersPosting[] = [];
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
      postings.push(...items);
      if (items.length < PAGE_SIZE) break;
    }

    // Per-posting detail fetch for description text. The listing endpoint
    // gives only summary fields; jobAd.sections.{jobDescription,
    // qualifications, additionalInformation} live on the detail endpoint.
    // Concurrency-bounded so a tenant with thousands of postings doesn't
    // saturate outbound connections, and capped so a single mega-tenant
    // can't blow the matrix runner's 45-minute budget. Postings beyond the
    // cap (oldest, since smartrecruiters listings are returned in
    // newest-first order) ship with listing-only data.
    const detailLimit = Math.min(postings.length, MAX_DETAIL_FETCH_PER_TENANT);
    const limit = pLimit(opts.perTenantConcurrency ?? DEFAULT_DETAIL_CONCURRENCY);
    const enriched = await Promise.all(
      postings.slice(0, detailLimit).map((p) =>
        limit(async (): Promise<SmartRecruitersPostingDetail | undefined> => {
          if (!p.id) return undefined;
          const detailUrl = `https://api.smartrecruiters.com/v1/companies/${opts.tenant.slug}/postings/${p.id}`;
          try {
            const res = await opts.client.request(detailUrl, { skipRobots: true });
            if (res.status >= 200 && res.status < 300) {
              return (await res.json()) as SmartRecruitersPostingDetail;
            }
          } catch {
            // Non-fatal — fall back to listing-only data for this posting.
          }
          return undefined;
        }),
      ),
    );

    const jobs: Job[] = [];
    for (let i = 0; i < postings.length; i++) {
      const posting = postings[i];
      if (!posting) continue;
      // enriched[] is shorter than postings[] when MAX_DETAIL_FETCH_PER_TENANT
      // capped the fan-out; `enriched[i]` is `undefined` for the tail.
      const job = postingToJob(opts.tenant.slug, company, opts.observedAt, posting, enriched[i]);
      if (job) jobs.push(job);
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
