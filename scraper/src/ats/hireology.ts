import { type Job, JobSchema, jobId, type TenantInput, type TenantResult } from "@openroles/shared";
import type { HttpClient } from "../http.ts";
import { excerpt, normalizeWorkplace, plainText, splitLocation } from "../normalize.ts";
import { assertSafeSlug, dedupeById, errorToResult, isRecruiterTitle } from "./common.ts";

// A single posting as returned in `data[]` by the public careers API
// (`api.hireology.com/v2/public/careers/{slug}`). The listing already
// carries the full HTML job description and the canonical career-site
// deep link, so one request per page covers title, location, workplace,
// department, excerpt and apply URL — no per-job detail fetch is needed.
interface HireologyLocation {
  city?: string | null;
  state?: string | null;
  zip_code?: string | null;
  address?: string | null;
}

interface HireologyJob {
  id?: number | null;
  name?: string | null;
  created_at?: string | null;
  status?: string | null;
  job_description?: string | null;
  locations?: ReadonlyArray<HireologyLocation> | null;
  remote?: boolean | null;
  job_family?: { name?: string | null } | null;
  career_site_url?: string | null;
  organization?: { name?: string | null } | null;
}

interface HireologyResponse {
  data?: ReadonlyArray<HireologyJob>;
  count?: number;
  page?: number;
  page_size?: number;
}

const PAGE_SIZE = 100;
// 4,000-posting ceiling per tenant. Hireology skews to franchise-local
// boards (single-digit role counts are the norm); the cap bounds the
// per-tenant fan-out so one anomalous mega-board cannot blow the matrix
// runner's time budget while still covering every real-world site.
const MAX_PAGES = 40;

// All roles the shared SPA host is set up to list. The public API has only ever
// been observed returning `status: "Open"`, but the field exists, so guard
// defensively: any explicit non-open status is filtered; a missing status is
// treated as open so a benign API change doesn't silently zero the corpus.
function isOpen(status: string | null | undefined): boolean {
  return typeof status !== "string" || status.trim().toLowerCase() === "open";
}

function trimmedOrUndefined(raw: string | null | undefined): string | undefined {
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : undefined;
}

// job_description is full HTML; plainText strips tags, decodes entities and
// collapses whitespace — without it raw newlines/tags would fail JobSchema's
// excerpt validation and drop the row.
function hireologyDescription(raw: string | null | undefined): string | undefined {
  const text = raw ? plainText(raw) : "";
  return text.length > 0 ? excerpt(text) : undefined;
}

// First entry of `locations[]` as "City, ST". Multi-location postings exist
// (one job row, several branches) but the board renders a single posting, so
// we keep it one row keyed on the first location — deterministic and matched
// to what the source publishes. Country is never present in the payload.
function hireologyLocationText(
  locations: ReadonlyArray<HireologyLocation> | null | undefined,
): string | undefined {
  const first = locations?.[0];
  if (!first) return undefined;
  const city = trimmedOrUndefined(first.city);
  const state = trimmedOrUndefined(first.state);
  if (city && state) return `${city}, ${state}`;
  return city ?? state;
}

// `remote: true` is an explicit, authoritative workplace signal from the
// posting form. When absent/false the payload carries no onsite/hybrid
// marker, so fall back to scanning the title + location text for a hint.
function hireologyWorkplace(
  remote: boolean | null | undefined,
  fallbackHint: string,
): Job["workplace_type"] {
  if (remote === true) return "remote";
  return normalizeWorkplace(fallbackHint);
}

// Canonical public job URL. Prefer the payload's own career_site_url when it
// is a well-formed https link on the shared SPA host; anything else (null,
// malformed, off-host) falls back to the constructed
// `careers.hireology.com/{slug}/{id}/description` deep link, whose shape is
// verified live. Anchoring to the canonical host keeps a tenant-supplied URL
// from ever pointing the corpus at an arbitrary origin.
function hireologyJobUrl(slug: string, sourceId: string, raw: string | null | undefined): string {
  if (typeof raw === "string") {
    try {
      const parsed = new URL(raw);
      if (parsed.protocol === "https:" && parsed.hostname === "careers.hireology.com") {
        return parsed.toString();
      }
    } catch {
      // fall through to the constructed deep link
    }
  }
  return `https://careers.hireology.com/${slug}/${sourceId}/description`;
}

// created_at carries millisecond-precision UTC timestamps. Drop any value
// that would violate the schema's posted_at <= last_seen_at rule (clock skew,
// scheduled postings) rather than letting safeParse reject the whole row.
function hireologyPostedAt(raw: string | null | undefined, observedAt: string): string | undefined {
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return undefined;
  const posted = d.toISOString();
  return posted <= observedAt ? posted : undefined;
}

function buildJob(
  tenantSlug: string,
  fallbackCompany: string,
  observedAt: string,
  j: HireologyJob,
): Job | null {
  if (typeof j.id !== "number" || !Number.isSafeInteger(j.id) || j.id <= 0) return null;
  // Titles occasionally carry HTML entities; plainText decodes and collapses.
  const title = trimmedOrUndefined(plainText(j.name ?? ""));
  if (!title) return null;
  if (!isOpen(j.status)) return null;

  const sourceId = String(j.id);
  const url = hireologyJobUrl(tenantSlug, sourceId, j.career_site_url);
  const id = jobId({ ats: "hireology", tenant_slug: tenantSlug, source_id: sourceId, url });

  const company = trimmedOrUndefined(j.organization?.name) ?? fallbackCompany;
  const locationText = hireologyLocationText(j.locations);
  const region = locationText ? splitLocation(locationText).region : undefined;
  const description = hireologyDescription(j.job_description);
  const department = trimmedOrUndefined(j.job_family?.name);
  const postedAt = hireologyPostedAt(j.created_at, observedAt);

  const candidate = {
    id,
    ats: "hireology",
    tenant_slug: tenantSlug,
    source_id: sourceId,
    title,
    company,
    level: null,
    level_rank: null,
    workplace_type: hireologyWorkplace(j.remote, `${title} ${locationText ?? ""}`),
    is_recruiter_post: isRecruiterTitle(title),
    ...(description ? { description_excerpt: description } : {}),
    ...(locationText ? { location_text: locationText } : {}),
    ...(region ? { location_region: region } : {}),
    ...(department ? { department } : {}),
    ...(postedAt ? { posted_at: postedAt } : {}),
    first_seen_at: observedAt,
    last_seen_at: observedAt,
    url,
  };
  const validated = JobSchema.safeParse(candidate);
  return validated.success ? validated.data : null;
}

export interface ParseHireologyJobsInput {
  readonly tenant: TenantInput;
  readonly company: string;
  readonly response: unknown;
  readonly observedAt: string;
}

// Pure parser over one careers-API page: `data[]` → validated Jobs, deduped
// by id. Decoupled from HTTP so it can be fixture-replayed and
// property-tested deterministically.
export function parseHireologyJobs(input: ParseHireologyJobsInput): Job[] {
  const body = input.response as HireologyResponse;
  const list = Array.isArray(body.data) ? body.data : [];
  const jobs: Job[] = [];
  for (const j of list) {
    const job = buildJob(input.tenant.slug, input.company, input.observedAt, j);
    if (job) jobs.push(job);
  }
  return dedupeById(jobs);
}

export interface ScrapeHireologyOptions {
  readonly tenant: TenantInput;
  readonly client: HttpClient;
  readonly observedAt: string;
}

export interface ScrapeHireologyOutcome {
  readonly jobs: ReadonlyArray<Job>;
  readonly result: TenantResult;
}

export async function scrapeHireologyTenant(
  opts: ScrapeHireologyOptions,
): Promise<ScrapeHireologyOutcome> {
  try {
    assertSafeSlug(opts.tenant.slug);
    const company = opts.tenant.display_name ?? opts.tenant.slug;
    const jobs: Job[] = [];
    let httpStatus = 0;
    let total = Number.POSITIVE_INFINITY;
    let fetched = 0;

    for (let page = 1; page <= MAX_PAGES; page++) {
      const url = `https://api.hireology.com/v2/public/careers/${opts.tenant.slug}?page=${page}&page_size=${PAGE_SIZE}`;
      const res = await opts.client.request(url);
      httpStatus = res.status;
      const body = (await res.json()) as HireologyResponse;
      if (typeof body.count === "number") total = body.count;
      const list = Array.isArray(body.data) ? body.data : [];
      fetched += list.length;
      for (const job of parseHireologyJobs({
        tenant: opts.tenant,
        company,
        response: body,
        observedAt: opts.observedAt,
      })) {
        jobs.push(job);
      }
      // A short page means the listing is exhausted; a full page that already
      // covers `count` avoids one guaranteed-empty trailing request.
      if (list.length < PAGE_SIZE || fetched >= total) break;
    }

    const deduped = dedupeById(jobs);
    return {
      jobs: deduped,
      result: {
        slug: opts.tenant.slug,
        status: "success",
        http_status: httpStatus,
        jobs_count: deduped.length,
      },
    };
  } catch (err) {
    return { jobs: [], result: errorToResult(opts.tenant.slug, err) };
  }
}
