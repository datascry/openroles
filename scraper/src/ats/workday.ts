import { type Job, JobSchema, type TenantInput, type TenantResult } from "@openroles/shared";
import { z } from "zod";
import { buildJob } from "../build-job.ts";
import { type HttpClient, HttpError } from "../http.ts";
import {
  assertSafeSlug,
  assertWorkdayHost,
  assertWorkdaySite,
  dedupeById,
  errorToResult,
  isRecruiterTitle,
} from "./common.ts";

const WorkdayJobPosting = z
  .object({
    title: z.string(),
    externalPath: z.string(),
    locationsText: z.string().optional(),
    postedOn: z.string().optional(),
    bulletFields: z.array(z.string()).optional(),
    jobReqId: z.string().optional(),
    jobFamily: z.string().optional(),
  })
  .passthrough();

const WorkdayResponse = z.object({
  total: z.number(),
  jobPostings: z.array(WorkdayJobPosting),
});

export interface WorkdayParseInput {
  readonly tenant: TenantInput;
  readonly company: string;
  readonly host: string;
  /**
   * The workday "site" the listing was actually scraped against (e.g.
   * "External", "Careers"). The /wday/cxs JSON returns externalPath
   * relative to /<site>, NOT relative to the host root, so the public-
   * facing job url has to interpolate the site segment between the host
   * and externalPath. Confirmed empirically:
   *   broken: https://aah.wd5.myworkdayjobs.com/job/.../R143019  → 404
   *   works: https://aah.wd5.myworkdayjobs.com/External/job/.../R143019 → 200
   * Without this, every workday Apply link 404s on the live site.
   */
  readonly site: string;
  readonly response: unknown;
  readonly observedAt: string;
}

function workdayJobUrl(host: string, site: string, externalPath: string): string {
  const path = externalPath.startsWith("/") ? externalPath : `/${externalPath}`;
  return `https://${host}/${site}${path}`;
}

function workdaySourceId(externalPath: string, jobReqId: string | undefined): string {
  if (jobReqId !== undefined && jobReqId.length > 0) return jobReqId;
  const parts = externalPath.split("/");
  return parts[parts.length - 1] ?? externalPath;
}

export function parseWorkdayJobs(input: WorkdayParseInput): Job[] {
  const parsed = WorkdayResponse.parse(input.response);
  const jobs: Job[] = [];
  for (const raw of parsed.jobPostings) {
    // Workday's /jobs listing doesn't return the full description. It
    // returns `bulletFields`, which in practice (sampled across nvidia,
    // blackrock, and others) is just the requisition id — not a real
    // description, but searchable so users can find a role by its req
    // number. Full descriptions need a per-job detail-page fetch, which
    // is deferred until we have a rate budget for it across ~4k tenants.
    const bullets = raw.bulletFields?.filter((b) => b.trim().length > 0).join(" • ");
    const candidate = buildJob({
      ats: "workday",
      tenant_slug: input.tenant.slug,
      company: input.company,
      source_id: workdaySourceId(raw.externalPath, raw.jobReqId),
      title: raw.title,
      url: workdayJobUrl(input.host, input.site, raw.externalPath),
      ...(bullets && bullets.length > 0 ? { description_text: bullets } : {}),
      ...(raw.locationsText !== undefined ? { location_text: raw.locationsText } : {}),
      workplace_hint: raw.locationsText ?? "",
      ...(raw.jobFamily !== undefined ? { department: raw.jobFamily } : {}),
      is_recruiter_post: isRecruiterTitle(raw.title),
      first_seen_at: input.observedAt,
      last_seen_at: input.observedAt,
    });
    const validated = JobSchema.safeParse(candidate);
    if (validated.success) jobs.push(validated.data);
  }
  return dedupeById(jobs);
}

export interface ScrapeWorkdayOptions {
  readonly tenant: TenantInput;
  readonly client: HttpClient;
  readonly observedAt: string;
  readonly host: string;
  readonly site: string;
  readonly pageSize?: number;
  readonly maxPages?: number;
}

export interface ScrapeTenantOutcome {
  readonly jobs: ReadonlyArray<Job>;
  readonly result: TenantResult;
}

const DEFAULT_PAGE_SIZE = 20;
const DEFAULT_MAX_PAGES = 200;

// Common workday public-board "site" names. Most tenants use `External`,
// but a long tail use `Careers`, `External_Career_Site`, or
// `External_Site`. Without a fallback, ~70% of harvested workday tenants
// 404 against External even when their public board exists under a
// different name. Order matters: External is by far the most common
// (try first), Careers is the next most common, the underscored
// variants are the long tail.
const SITE_FALLBACKS: ReadonlyArray<string> = [
  "External",
  "Careers",
  "External_Career_Site",
  "External_Site",
];

interface SiteAttempt {
  readonly status: "ok" | "not-found" | "error";
  readonly jobs?: ReadonlyArray<Job>;
  readonly httpStatus?: number;
  readonly error?: unknown;
}

async function scrapeWithSite(opts: ScrapeWorkdayOptions, site: string): Promise<SiteAttempt> {
  const limit = opts.pageSize ?? DEFAULT_PAGE_SIZE;
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
  const collected: Job[] = [];
  let total = Number.POSITIVE_INFINITY;
  let lastStatus = 0;
  let firstPageDone = false;
  try {
    assertWorkdaySite(site);
    const url = `https://${opts.host}/wday/cxs/${opts.tenant.slug}/${site}/jobs`;
    for (let page = 0; page < maxPages; page++) {
      const offset = page * limit;
      if (offset >= total) break;
      const res = await opts.client.request(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          appliedFacets: {},
          limit,
          offset,
          searchText: "",
        }),
      });
      lastStatus = res.status;
      const body = await res.json();
      const parsed = WorkdayResponse.parse(body);
      total = parsed.total;
      const pageJobs = parseWorkdayJobs({
        tenant: opts.tenant,
        company: opts.tenant.display_name ?? opts.tenant.slug,
        host: opts.host,
        // Use the site that actually returned 200 (in the alt-site
        // fallback chain), not opts.site which is the dispatcher's
        // default. Otherwise tenants whose public board lives at
        // Careers / External_Career_Site get URLs that point at
        // /External/<path> and 404.
        site,
        response: body,
        observedAt: opts.observedAt,
      });
      for (const j of pageJobs) collected.push(j);
      firstPageDone = true;
      if (parsed.jobPostings.length < limit) break;
    }
    return { status: "ok", jobs: dedupeById(collected), httpStatus: lastStatus };
  } catch (err) {
    // 404 only counts as "not-found" if it came on page 0 — once we've
    // committed to a site by reading at least one valid page, a later
    // 404 is a real failure (vendor outage, cursor invalidated, etc.)
    // and we shouldn't silently swap to a different site mid-pagination.
    if (!firstPageDone && err instanceof HttpError && err.status === 404) {
      return { status: "not-found", error: err };
    }
    return { status: "error", error: err };
  }
}

export async function scrapeWorkdayTenant(
  opts: ScrapeWorkdayOptions,
): Promise<ScrapeTenantOutcome> {
  try {
    assertSafeSlug(opts.tenant.slug);
    assertWorkdayHost(opts.host);
  } catch (err) {
    return { jobs: [], result: errorToResult(opts.tenant.slug, err) };
  }

  // Build the candidate list: dispatcher-supplied site first (whatever
  // harvest captured, or the External default), then the rest of the
  // common fallbacks. Dedup so we don't retry the same site twice when
  // opts.site is already in SITE_FALLBACKS.
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const s of [opts.site, ...SITE_FALLBACKS]) {
    if (!seen.has(s)) {
      candidates.push(s);
      seen.add(s);
    }
  }

  let lastNotFound: unknown = null;
  for (const site of candidates) {
    const attempt = await scrapeWithSite(opts, site);
    if (attempt.status === "ok") {
      const jobs = attempt.jobs ?? [];
      return {
        jobs,
        result: {
          slug: opts.tenant.slug,
          status: "success",
          http_status: attempt.httpStatus ?? 200,
          jobs_count: jobs.length,
        },
      };
    }
    if (attempt.status === "not-found") {
      lastNotFound = attempt.error;
      continue;
    }
    // Non-404 error (auth, validation, server, transient) — don't keep
    // retrying alternate sites. The tenant either exists with this site
    // and is gated, or has a deeper problem that switching sites won't
    // resolve.
    return { jobs: [], result: errorToResult(opts.tenant.slug, attempt.error) };
  }

  // Every candidate site 404'd — surface the last 404 as the dead reason.
  return { jobs: [], result: errorToResult(opts.tenant.slug, lastNotFound) };
}
