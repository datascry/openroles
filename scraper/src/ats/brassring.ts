import { type Job, JobSchema, type TenantInput, type TenantResult } from "@openroles/shared";
import { z } from "zod";
import { buildJob } from "../build-job.ts";
import type { HttpClient } from "../http.ts";
import { assertSafeSlug, dedupeById, errorToResult, isRecruiterTitle } from "./common.ts";

// IBM Kenexa / BrassRing Talent Suite. Multi-tenant ATS used by
// Publix, Hobby Lobby, Best Buy, Harbor Freight, HCL Technologies,
// ADM, Performance Food Group, GardaWorld, Habitat for Humanity,
// Helzberg, and roughly 100+ Fortune-1000 + university customers
// (CC-MAIN-2026-17 enumerated 123 distinct (partnerid, siteid) pairs).
//
// Tenant identity = (partnerid, siteid). All BrassRing customers
// share the same host (`sjobs.brassring.com`); the pair selects the
// tenant within that host. Some brands have multiple siteids under
// one partnerid (Lockheed Martin: 25037/5010 + 25037/5014); when a
// brand exposes multiple sites, seed each as a separate Tenant with
// a distinct slug.
//
// Lockheed Martin is intentionally NOT seeded here despite being a
// BrassRing customer: its TalentBrew SEO front-end at
// lockheedmartinjobs.com is already in data/tenants/jsonld.json with
// ~3,933 jobs that include descriptions (which this adapter's
// search-results endpoint omits). Cross-ATS jobs would dupe under
// different `url` keys — same lesson learned in the phenom and
// workday-AT&T investigations.
//
// API flow (two-step, CSRF-token + cookie-session):
//
//   1. GET https://sjobs.brassring.com/TGNewUI/Search/Home/Home?partnerid=PID&siteid=SID
//      → parse `__RequestVerificationToken` from the response HTML
//      → capture Set-Cookie headers (Workday-style session bootstrap)
//
//   2. POST https://sjobs.brassring.com/TgNewUI/Search/Ajax/PowerSearchJobs
//      headers: { Cookie: <accumulated>, RFT: <token>,
//                 Content-Type: application/json,
//                 Referer: home URL, Origin: sjobs.brassring.com }
//      body: { siteId: SID, partnerId: PID, pageNumber: N, ... }
//
//   3. Response: { Jobs: { Job: [...] }, JobsCount, ... }
//
// Each Job in the response is a flat `Questions[]` array of
// {QuestionName, Value} pairs. We project to a `Job` record by
// reading specific QuestionNames: `reqid` (source_id), `jobtitle`
// (title), `location` (location_text), `lastupdated` (posted_at).
// The search-results endpoint does not include the job description;
// callers wanting description must fetch each `Job.Link` (JobDetails)
// per-job. Initial pass surfaces title + location only.

const BR_HOST = "sjobs.brassring.com";
const PAGE_SIZE = 50;
const DEFAULT_MAX_PAGES = 50; // 2,500 jobs ceiling per tenant per pass

const RFT_RE = /name="__RequestVerificationToken"[^>]*value="([^"]+)"/;

const PARTNER_ID_RE = /^[0-9]{1,9}$/;
const SITE_ID_RE = /^[0-9]{1,9}$/;

const BrassringQuestion = z
  .object({
    QuestionName: z.string(),
    Value: z.union([z.string(), z.number(), z.null()]).optional(),
  })
  .passthrough();

const BrassringJobRecord = z
  .object({
    Questions: z.array(BrassringQuestion).optional(),
    Link: z.string().optional(),
  })
  .passthrough();

const BrassringResponse = z
  .object({
    Jobs: z.object({ Job: z.array(BrassringJobRecord).optional() }).optional(),
    JobsCount: z.number().optional(),
    TotalJobsCount: z.number().optional(),
  })
  .passthrough();

type BrassringJob = z.infer<typeof BrassringJobRecord>;

function readQuestion(job: BrassringJob, name: string): string | undefined {
  const qs = job.Questions ?? [];
  for (const q of qs) {
    if (q.QuestionName !== name) continue;
    const v = q.Value;
    if (typeof v === "string") {
      const trimmed = v.trim();
      if (trimmed.length > 0) return trimmed;
    } else if (typeof v === "number") {
      return String(v);
    }
  }
  return undefined;
}

// BrassRing emits `lastupdated` as "DD-Mon-YYYY" — e.g. "14-May-2026".
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

export function normalizeBrassringDate(v: string): string | undefined {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(v);
  if (m?.[2]) {
    const day = (m[1] ?? "").padStart(2, "0");
    const monthKey = m[2].toLowerCase();
    const mon = MONTH_MAP[monthKey];
    if (!mon) return undefined;
    return `${m[3]}-${mon}-${day}T00:00:00Z`;
  }
  // ISO fallback for any variant we haven't seen yet.
  const d = new Date(v);
  if (!Number.isNaN(d.getTime())) return d.toISOString();
  return undefined;
}

// Returns true only for digit-string IDs in the documented range.
// Reject anything else early — these flow into URL query strings and
// JSON bodies; SSRF / template-injection guard.
export function assertBrassringIds(partnerId: string, siteId: string): void {
  if (!PARTNER_ID_RE.test(partnerId)) {
    throw new Error(`brassring partnerid rejected: ${JSON.stringify(partnerId)}`);
  }
  if (!SITE_ID_RE.test(siteId)) {
    throw new Error(`brassring siteid rejected: ${JSON.stringify(siteId)}`);
  }
}

export function homeUrlFor(partnerId: string, siteId: string): string {
  return `https://${BR_HOST}/TGNewUI/Search/Home/Home?partnerid=${partnerId}&siteid=${siteId}`;
}

export function jobDetailsUrlFor(partnerId: string, siteId: string, reqId: string): string {
  return `https://${BR_HOST}/TGnewUI/Search/home/HomeWithPreLoad?partnerid=${partnerId}&siteid=${siteId}&PageType=JobDetails&jobid=${encodeURIComponent(reqId)}`;
}

/**
 * Extract `__RequestVerificationToken` from the BrassRing home page
 * HTML. The token lives in a hidden input within the search form and
 * is required (alongside the session cookies set on the same response)
 * for every subsequent POST to /TgNewUI/Search/Ajax/PowerSearchJobs.
 * Returns null when the token is missing — the caller should treat
 * the tenant as transient_failure.
 */
export function extractRft(html: string): string | null {
  const m = RFT_RE.exec(html);
  return m?.[1] ?? null;
}

/**
 * Convert a list of `Set-Cookie` header values into a single `Cookie`
 * header value to replay on the next request. We only carry the
 * `name=value` prefix of each Set-Cookie (the leftmost segment before
 * `;`) — attributes like Path, Expires, HttpOnly are server-side
 * concerns and shouldn't be echoed back. Empty input → empty cookie.
 */
export function buildCookieHeader(setCookies: ReadonlyArray<string>): string {
  const out: string[] = [];
  for (const sc of setCookies) {
    const semi = sc.indexOf(";");
    const pair = (semi === -1 ? sc : sc.slice(0, semi)).trim();
    if (pair.length > 0) out.push(pair);
  }
  return out.join("; ");
}

export interface ParseBrassringJobsInput {
  readonly tenant: TenantInput;
  readonly company: string;
  readonly partnerId: string;
  readonly siteId: string;
  readonly response: unknown;
  readonly observedAt: string;
}

/**
 * Parse one page of BrassRing PowerSearchJobs JSON into normalised Job
 * records. Pure; deterministic; safe to property-test.
 *
 * The search-results endpoint omits the job description, so the Job
 * surface here is title + location + posted_at only. A follow-up that
 * fetches `Job.Link` (JobDetails) per-job would land descriptions, but
 * is an N+1 cost we're not paying in the initial pass.
 */
export function parseBrassringJobs(input: ParseBrassringJobsInput): Job[] {
  const parsed = BrassringResponse.parse(input.response);
  const jobs = parsed.Jobs?.Job ?? [];
  const out: Job[] = [];
  for (const j of jobs) {
    const reqid = readQuestion(j, "reqid");
    const title = readQuestion(j, "jobtitle");
    if (!reqid || !title) continue;
    const location = readQuestion(j, "location");
    const lastupdated = readQuestion(j, "lastupdated");
    const url =
      typeof j.Link === "string" && j.Link.startsWith(`https://${BR_HOST}/`)
        ? j.Link
        : jobDetailsUrlFor(input.partnerId, input.siteId, reqid);
    const postedAt = lastupdated !== undefined ? normalizeBrassringDate(lastupdated) : undefined;
    const candidate = buildJob({
      ats: "brassring",
      tenant_slug: input.tenant.slug,
      company: input.company,
      source_id: reqid,
      title,
      url,
      ...(location !== undefined ? { location_text: location } : {}),
      workplace_hint: location ?? "",
      ...(postedAt !== undefined ? { posted_at: postedAt } : {}),
      is_recruiter_post: isRecruiterTitle(title),
      first_seen_at: input.observedAt,
      last_seen_at: input.observedAt,
    });
    const validated = JobSchema.safeParse(candidate);
    if (validated.success) out.push(validated.data);
  }
  return dedupeById(out);
}

export interface ScrapeBrassringOptions {
  readonly tenant: TenantInput;
  readonly client: HttpClient;
  readonly observedAt: string;
  readonly partnerId: string;
  readonly siteId: string;
  readonly maxPages?: number;
}

export interface ScrapeBrassringOutcome {
  readonly jobs: ReadonlyArray<Job>;
  readonly result: TenantResult;
}

/**
 * Read all Set-Cookie header values from a Response. Bun's Headers
 * implementation exposes `getSetCookie()` (Node 18+ standard); we
 * rely on it directly rather than falling back to comma-splitting
 * the combined header string — browsers fold Set-Cookie incorrectly
 * because cookie attributes can contain commas (e.g.
 * `Expires=Thu, 14 May 2026 ...`), so the split-then-rejoin
 * fallback would mis-parse real-world Workday/BrassRing cookies.
 */
function readSetCookies(headers: Headers): string[] {
  return headers.getSetCookie();
}

export async function scrapeBrassringTenant(
  opts: ScrapeBrassringOptions,
): Promise<ScrapeBrassringOutcome> {
  let lastHttpStatus = 0;
  try {
    assertSafeSlug(opts.tenant.slug);
    assertBrassringIds(opts.partnerId, opts.siteId);
  } catch (err) {
    return { jobs: [], result: errorToResult(opts.tenant.slug, err) };
  }

  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
  const homeUrl = homeUrlFor(opts.partnerId, opts.siteId);
  const company = opts.tenant.display_name ?? opts.tenant.slug;

  try {
    // Step 1: GET the home page to capture RFT + session cookies.
    const homeRes = await opts.client.request(homeUrl, { method: "GET" });
    lastHttpStatus = homeRes.status;
    const homeHtml = await homeRes.text();
    const rft = extractRft(homeHtml);
    if (rft === null) {
      return {
        jobs: [],
        result: {
          slug: opts.tenant.slug,
          status: "transient_failure",
          http_status: lastHttpStatus,
          error: "RequestVerificationToken not found on home page",
          jobs_count: 0,
        },
      };
    }
    const cookie = buildCookieHeader(readSetCookies(homeRes.headers));

    // Step 2: paginate POST /TgNewUI/Search/Ajax/PowerSearchJobs.
    const apiUrl = `https://${BR_HOST}/TgNewUI/Search/Ajax/PowerSearchJobs`;
    const collected: Job[] = [];
    let total = Number.POSITIVE_INFINITY;
    for (let page = 1; page <= maxPages; page++) {
      if ((page - 1) * PAGE_SIZE >= total) break;
      const body = JSON.stringify({
        siteId: Number.parseInt(opts.siteId, 10),
        partnerId: Number.parseInt(opts.partnerId, 10),
        pageNumber: page,
        smartSearchKeyword: "",
        smartSearchTypeId: 0,
        advancedSearchCriteria: {},
        savedSearchKey: "",
        facetsValuesData: [],
        language: "en",
        currentLanguage: "en",
      });
      const res = await opts.client.request(apiUrl, {
        method: "POST",
        body,
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          rft: rft,
          ...(cookie.length > 0 ? { cookie } : {}),
          referer: homeUrl,
          origin: `https://${BR_HOST}`,
        },
      });
      lastHttpStatus = res.status;
      const json = (await res.json()) as unknown;
      const parsed = BrassringResponse.parse(json);
      if (typeof parsed.JobsCount === "number") total = parsed.JobsCount;
      const pageJobs = parseBrassringJobs({
        tenant: opts.tenant,
        company,
        partnerId: opts.partnerId,
        siteId: opts.siteId,
        response: json,
        observedAt: opts.observedAt,
      });
      for (const j of pageJobs) collected.push(j);
      const got = parsed.Jobs?.Job?.length ?? 0;
      if (got < PAGE_SIZE) break;
    }
    const jobs = dedupeById(collected);
    return {
      jobs,
      result: {
        slug: opts.tenant.slug,
        status: "success",
        http_status: lastHttpStatus || 200,
        jobs_count: jobs.length,
      },
    };
  } catch (err) {
    return { jobs: [], result: errorToResult(opts.tenant.slug, err) };
  }
}
