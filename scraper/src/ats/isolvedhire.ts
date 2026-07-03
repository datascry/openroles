import { type Job, JobSchema, type TenantInput, type TenantResult } from "@openroles/shared";
import { buildJob } from "../build-job.ts";
import { type HttpClient, HttpError } from "../http.ts";
import { plainText } from "../normalize.ts";
import { assertSafeSlug, dedupeById, errorToResult, isRecruiterTitle } from "./common.ts";

// isolved Hire hosted boards at `{slug}.isolvedhire.com`. The public board
// page (`/jobs/`) is a Vue SPA whose loader script embeds a
// `courierCurrentRouteData` JSON blob carrying the per-tenant `domain_id`;
// the JSON endpoint at `/core/jobs/{domainId}?getParams={"isInternal":0}`
// then returns the ENTIRE job list in a single call (no pagination) as
// `{ success, data: { jobs: [...] } }`. Each entry carries title, city /
// abbreviation / stateName / iso3, workplaceType (Onsite / Hybrid / Remote),
// employmentType, classification, a posting date (`startDateRef`,
// "MMM DD, YYYY"; `endDateRef` is the listing-window close), min/max salary
// strings, and a canonical `jobUrl` (`https://{slug}.isolvedhire.com/jobs/{id}`)
// — but no description; fetching one would cost a per-job HTML request and
// isn't worth the multiplication at scale. robots.txt only disallows
// /admin/, /stats/ and the /internaljobs* surfaces, so both steps are
// crawl-permitted. Tenant identity = slug (subdomain); no metadata needed.

const DOMAIN_ID_RE =
  /courierCurrentRouteData\s*=\s*\{[^{}]*?["']domain_id["']\s*:\s*["']?(\d{1,12})["']?/;

/**
 * Extract the per-tenant `domain_id` from the board page's
 * `courierCurrentRouteData` bootstrap blob. Returns null when the blob (or
 * the field) is absent — the caller treats that tenant as dead, because a
 * board page without the blob is a vendor "not set" placeholder, not a
 * live-but-empty board.
 */
export function extractIsolvedhireDomainId(html: string): string | null {
  const m = DOMAIN_ID_RE.exec(html);
  return m?.[1] ?? null;
}

// The board emits posting dates as "MMM DD, YYYY" — e.g. "Apr 17, 2026".
// Normalise to the canonical UTC-midnight ISO shape JobSchema enforces.
const MONTH_MAP: Record<string, string> = {
  jan: "01",
  feb: "02",
  mar: "03",
  apr: "04",
  may: "05",
  jun: "06",
  jul: "07",
  aug: "08",
  sep: "09",
  oct: "10",
  nov: "11",
  dec: "12",
};

export function normalizeIsolvedhireDate(value: string): string | undefined {
  const m = /^([A-Za-z]{3})\s+(\d{1,2}),\s*(\d{4})$/.exec(value.trim());
  if (!m?.[1]) return undefined;
  const mon = MONTH_MAP[m[1].toLowerCase()];
  if (!mon) return undefined;
  const day = (m[2] ?? "").padStart(2, "0");
  return `${m[3]}-${mon}-${day}T00:00:00Z`;
}

interface IsolvedhireJobRecord {
  id?: number | string;
  title?: string | null;
  city?: string | null;
  iso3?: string | null;
  abbreviation?: string | null;
  classification?: string | null;
  jobCategory?: string | null;
  stateName?: string | null;
  workplaceType?: string | null;
  employmentType?: string | null;
  startDateRef?: string | null;
  minSalary?: string | null;
  maxSalary?: string | null;
  jobLocation?: string | null;
  jobUrl?: string;
}

interface IsolvedhireResponse {
  success?: boolean;
  data?: {
    jobs?: ReadonlyArray<IsolvedhireJobRecord>;
  } | null;
}

function workplaceFrom(value: string | null | undefined): Job["workplace_type"] {
  switch (value?.toLowerCase()) {
    case "remote":
      return "remote";
    case "hybrid":
      return "hybrid";
    case "onsite":
    case "on-site":
      return "onsite";
    default:
      return null;
  }
}

// The board reports countries as ISO 3166-1 alpha-3; JobSchema stores
// alpha-2. Unknown codes map to undefined rather than guessing.
const ISO3_TO_ISO2: Record<string, string> = {
  USA: "US",
  CAN: "CA",
  GBR: "GB",
  IRL: "IE",
  AUS: "AU",
  NZL: "NZ",
  MEX: "MX",
  DEU: "DE",
  FRA: "FR",
  IND: "IN",
  PHL: "PH",
  PRI: "PR",
};

function countryFrom(iso3: string | null | undefined): string | undefined {
  return typeof iso3 === "string" ? ISO3_TO_ISO2[iso3.toUpperCase()] : undefined;
}

// Salary bounds arrive as display strings — "20", "22.5", "75,000" — with
// comma grouping on annual figures. JobSchema stores integers; rounding to
// the nearest whole unit keeps the signal (sortable, comparable) without
// inventing precision. Zero/negative/garbage → undefined.
function parseMoney(value: string | null | undefined): number | undefined {
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  const n = Number.parseFloat(value.replace(/,/g, ""));
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.round(n);
}

function trimmedOrUndefined(raw: string | null | undefined): string | undefined {
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : undefined;
}

// Posting dates are date-only → UTC midnight, which is <= observedAt for any
// same-day posting. Drop values in the future (mis-set listing windows)
// rather than letting safeParse reject the whole row.
function postedAtFrom(raw: string | null | undefined, observedAt: string): string | undefined {
  if (typeof raw !== "string") return undefined;
  const posted = normalizeIsolvedhireDate(raw);
  if (posted === undefined) return undefined;
  return Date.parse(posted) <= Date.parse(observedAt) ? posted : undefined;
}

// Only trust a record's own jobUrl when it points back into the hosted-board
// domain over https; anything else (scheme downgrade, off-platform host)
// falls back to the composed canonical URL. The public job page answers at
// `/jobs/{id}` — the exact URL the API itself emits in `jobUrl`.
function jobUrlFor(slug: string, sourceId: string, rawUrl: string | undefined): string {
  if (typeof rawUrl === "string" && rawUrl.startsWith("https://")) {
    try {
      const parsed = new URL(rawUrl);
      // Reject userinfo outright: URL.hostname strips `user:pass@`, so a
      // credentialed link would pass the host check yet publish the
      // credentials verbatim in Job.url.
      if (
        parsed.username === "" &&
        parsed.password === "" &&
        parsed.hostname.endsWith(".isolvedhire.com")
      )
        return rawUrl;
    } catch {
      // fall through to the composed URL
    }
  }
  return `https://${slug}.isolvedhire.com/jobs/${encodeURIComponent(sourceId)}`;
}

export interface ParseIsolvedhireJobsInput {
  readonly tenant: TenantInput;
  readonly company: string;
  readonly response: unknown;
  readonly observedAt: string;
}

/**
 * Parse one `/core/jobs/{domainId}` response into normalised Job records.
 * Pure; deterministic; safe to property-test.
 *
 * `success: false` (or a missing `data.jobs` array) is a server-side fault
 * in the job-list service, not an empty board — an empty board still answers
 * `success: true` with `jobs: []`. Throwing a transient HttpError here keeps
 * the tenant alive for the next run instead of recording a false zero.
 */
export function parseIsolvedhireJobs(input: ParseIsolvedhireJobsInput): Job[] {
  const body = input.response as IsolvedhireResponse;
  if (body.success !== true || !Array.isArray(body.data?.jobs)) {
    throw new HttpError(
      "transient",
      "isolvedhire job list unavailable (success=false or no data.jobs)",
    );
  }
  const out: Job[] = [];
  for (const item of body.data.jobs) {
    if (item.id === undefined) continue;
    const rawTitle = trimmedOrUndefined(item.title);
    if (rawTitle === undefined) continue;
    // Titles occasionally carry HTML entities (`&amp;`); decode to plain text.
    const title = plainText(rawTitle) || rawTitle;
    const sourceId = String(item.id);
    const url = jobUrlFor(input.tenant.slug, sourceId, item.jobUrl);

    // "City, ST" from the structured fields; the free-form jobLocation
    // (often a full street address) is only a fallback when both are blank.
    const cityState = [trimmedOrUndefined(item.city), trimmedOrUndefined(item.abbreviation)]
      .filter((p): p is string => p !== undefined)
      .join(", ");
    const locationText = cityState.length > 0 ? cityState : trimmedOrUndefined(item.jobLocation);

    const postedAt = postedAtFrom(item.startDateRef, input.observedAt);
    const department =
      trimmedOrUndefined(item.classification) ?? trimmedOrUndefined(item.jobCategory);
    let compMin = parseMoney(item.minSalary);
    let compMax = parseMoney(item.maxSalary);
    if (compMin !== undefined && compMax !== undefined && compMin > compMax) {
      // An inverted range is vendor noise; drop the pair, keep the row.
      compMin = undefined;
      compMax = undefined;
    }

    const candidate = buildJob({
      ats: "isolvedhire",
      tenant_slug: input.tenant.slug,
      company: input.company,
      source_id: sourceId,
      title,
      url,
      ...(locationText !== undefined ? { location_text: locationText } : {}),
      workplace_hint: `${title} ${locationText ?? ""}`,
      ...(department !== undefined ? { department } : {}),
      ...(postedAt !== undefined ? { posted_at: postedAt } : {}),
      ...(compMin !== undefined ? { compensation_min: compMin } : {}),
      ...(compMax !== undefined ? { compensation_max: compMax } : {}),
      is_recruiter_post: isRecruiterTitle(title),
      first_seen_at: input.observedAt,
      last_seen_at: input.observedAt,
    });
    // Apply the structured workplace + country directly — the board's own
    // workplaceType beats string-hint inference, and the iso3 country code
    // is authoritative where "City, ST" text carries no country at all.
    const country = countryFrom(item.iso3);
    const enriched: Job = {
      ...candidate,
      workplace_type: workplaceFrom(item.workplaceType) ?? candidate.workplace_type,
      ...(country !== undefined ? { location_country: country } : {}),
    };
    const validated = JobSchema.safeParse(enriched);
    if (validated.success) out.push(validated.data);
  }
  return dedupeById(out);
}

export interface ScrapeIsolvedhireOptions {
  readonly tenant: TenantInput;
  readonly client: HttpClient;
  readonly observedAt: string;
}

export interface ScrapeIsolvedhireOutcome {
  readonly jobs: ReadonlyArray<Job>;
  readonly result: TenantResult;
}

export async function scrapeIsolvedhireTenant(
  opts: ScrapeIsolvedhireOptions,
): Promise<ScrapeIsolvedhireOutcome> {
  try {
    assertSafeSlug(opts.tenant.slug);
    // Step 1: GET the board page to discover the per-tenant domain_id.
    const boardUrl = `https://${opts.tenant.slug}.isolvedhire.com/jobs/`;
    const boardRes = await opts.client.request(boardUrl);
    const boardHtml = await boardRes.text();
    const domainId = extractIsolvedhireDomainId(boardHtml);
    if (domainId === null) {
      // A 2xx page without the bootstrap blob is the vendor's "not set"
      // placeholder (unknown subdomains 302 to it on the same host), so
      // the subdomain does not address a live board.
      return {
        jobs: [],
        result: {
          slug: opts.tenant.slug,
          status: "dead",
          http_status: boardRes.status,
          error: "courierCurrentRouteData domain_id not found on board page",
          jobs_count: 0,
        },
      };
    }
    // Step 2: GET the full job list. getParams is JSON-encoded;
    // `{"isInternal":0}` asks for the public (external) postings.
    const apiUrl = `https://${opts.tenant.slug}.isolvedhire.com/core/jobs/${domainId}?getParams=%7B%22isInternal%22%3A0%7D`;
    const apiRes = await opts.client.request(apiUrl);
    const body = (await apiRes.json()) as unknown;
    const company = opts.tenant.display_name ?? opts.tenant.slug;
    const jobs = parseIsolvedhireJobs({
      tenant: opts.tenant,
      company,
      response: body,
      observedAt: opts.observedAt,
    });
    return {
      jobs,
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
