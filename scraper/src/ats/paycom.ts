import { type Job, JobSchema, type TenantInput, type TenantResult } from "@openroles/shared";
import pLimit from "p-limit";
import { buildJob } from "../build-job.ts";
import type { HttpClient } from "../http.ts";
import { plainText } from "../normalize.ts";
import { assertSafeSlug, dedupeById, errorToResult, isRecruiterTitle } from "./common.ts";

// Paycom hosted career portals. Tenant identity = the public 32-hex
// `clientkey`, stored lowercase (it round-trips through assertSafeSlug's
// [a-z0-9-]{1,64} charset) and re-uppercased for every portal URL. The
// career page embeds a `configsFromHost` object with a public,
// auto-issued `sessionJWT` (~2h RS256 Bearer, handed to every visitor —
// no login) and a `libConfig` JSON string whose `atsPortalMantleServiceUrl`
// is the per-tenant API base. That base lives on a per-pod host
// (`portal-applicant-tracking.{pod}.paycomonline.net`), so it MUST be read
// from libConfig, never hardcoded — and SSRF-guarded to the pod shape below
// before any request flows to it.

const CLIENTKEY_RE = /^[0-9a-f]{32}$/;

// SSRF guard for the tenant-supplied API base. The host is extracted from
// the page's libConfig, so it is untrusted input flowing into HTTP requests;
// anchoring to the `portal-applicant-tracking.{pod}.paycomonline.net` shape
// over https means a tenant can only ever address a Paycom pod, never an
// arbitrary origin. `{pod}` is a datacenter label (`us-cent`, `us-east`, …).
const PAYCOM_API_HOST = /^portal-applicant-tracking\.[a-z0-9-]+\.paycomonline\.net$/;

export interface PaycomSession {
  readonly sessionJWT: string;
  // Normalised to a trailing slash so `${apiBase}api/ats/...` composes cleanly.
  readonly apiBase: string;
}

// The career page embeds `var configsFromHost = { ... };` as a single JSON
// object literal. `sessionJWT` is a bare string; `libConfig` is itself a
// JSON string (double-encoded) whose `atsPortalMantleServiceUrl` is the API
// base. We isolate the object with a balanced-brace scan from the anchor,
// then JSON.parse it — a regex can't reliably span the ~2.4k-char JWT plus
// the escaped libConfig blob.
const CONFIGS_ANCHOR = "configsFromHost = {";

function sliceConfigsObject(html: string): string | null {
  const anchor = html.indexOf(CONFIGS_ANCHOR);
  if (anchor === -1) return null;
  const start = anchor + CONFIGS_ANCHOR.length - 1; // point at the `{`
  let depth = 0;
  // -1 = outside a string; 0 = inside; 1 = inside, next char escaped.
  let str = -1;
  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (str >= 0) {
      str = nextStringState(str, ch);
      continue;
    }
    if (ch === '"') str = 0;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return html.slice(start, i + 1);
  }
  return null;
}

// Advance the in-string scanner one character. `state` is 1 when the previous
// char was a backslash (this char is escaped and can't close the string).
function nextStringState(state: number, ch: string | undefined): number {
  if (state === 1) return 0; // escaped char consumed
  if (ch === "\\") return 1; // begin escape
  if (ch === '"') return -1; // close string
  return 0;
}

interface ConfigsFromHost {
  sessionJWT?: unknown;
  libConfig?: unknown;
}

/**
 * Extract the per-tenant `{ sessionJWT, apiBase }` from the career page's
 * `configsFromHost` bootstrap object. Returns null — the caller treats the
 * tenant as dead — when:
 *  - the bootstrap object is absent (the "portal does not exist" placeholder
 *    a dead/unknown clientkey serves is a plain page with no configsFromHost),
 *  - the JWT is missing/blank,
 *  - libConfig or its `atsPortalMantleServiceUrl` is missing/unparseable, or
 *  - the API base fails the SSRF host guard.
 *
 * Pure and deterministic — safe to fixture-replay and property-test.
 */
export function extractPaycomSession(html: string): PaycomSession | null {
  const raw = sliceConfigsObject(html);
  if (raw === null) return null;
  let configs: ConfigsFromHost;
  try {
    configs = JSON.parse(raw) as ConfigsFromHost;
  } catch {
    return null;
  }
  const jwt = typeof configs.sessionJWT === "string" ? configs.sessionJWT.trim() : "";
  if (jwt.length === 0) return null;

  if (typeof configs.libConfig !== "string") return null;
  let lib: { atsPortalMantleServiceUrl?: unknown };
  try {
    lib = JSON.parse(configs.libConfig) as { atsPortalMantleServiceUrl?: unknown };
  } catch {
    return null;
  }
  const baseRaw =
    typeof lib.atsPortalMantleServiceUrl === "string" ? lib.atsPortalMantleServiceUrl.trim() : "";
  if (baseRaw.length === 0) return null;

  let parsed: URL;
  try {
    parsed = new URL(baseRaw);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  if (parsed.username !== "" || parsed.password !== "") return null;
  if (!PAYCOM_API_HOST.test(parsed.hostname)) return null;

  const apiBase = baseRaw.endsWith("/") ? baseRaw : `${baseRaw}/`;
  return { sessionJWT: jwt, apiBase };
}

// One row of the list resource `api/ats/job-posting-previews/search`. The
// preview carries identity + title + description but frequently leaves
// `locations`/`postedOn` blank; those live on the per-job detail resource.
interface PaycomPreview {
  jobId?: number | string | null;
  jobTitle?: string | null;
  positionType?: string | null;
  remoteType?: string | null;
  locations?: string | null;
  description?: string | null;
  postedOn?: string | null;
}

interface PaycomSearchResponse {
  jobPostingPreviews?: ReadonlyArray<PaycomPreview> | null;
  jobPostingPreviewsCount?: number | null;
}

// The detail resource `api/ats/job-postings/{jobId}` (wrapped in
// `{ jobPosting: {...} }`). Adds the location/city, salary range and start
// date the preview omits.
export interface PaycomDetail {
  jobId?: number | string | null;
  location?: string | null;
  city?: string | null;
  remoteType?: string | null;
  positionType?: string | null;
  jobCategory?: string | null;
  description?: string | null;
  salaryRange?: string | null;
  startDate?: string | null;
}

interface PaycomDetailResponse {
  jobPosting?: PaycomDetail | null;
}

// Per-tenant detail fan-out bounds — mirror the rippling convention. A board
// past the cap still emits every role (list-only for the tail) and reports a
// "capped" note rather than silently truncating; the concurrency limit keeps
// the fan-out gentle on the per-pod API host.
const MAX_DETAIL_FETCH_PER_TENANT = 500;
const DEFAULT_PER_TENANT_CONCURRENCY = 6;
const DEFAULT_PAGE_SIZE = 100;
// Absolute page ceiling. The loop normally stops on a short page or the
// reported count, but a server returning only full pages while omitting the
// count would otherwise loop unbounded — this backstops it at 50k roles,
// far beyond any real tenant.
const MAX_SEARCH_PAGES = 500;

const SEARCH_FILTERS = {
  distanceFrom: 0,
  workEnvironments: [],
  positionTypes: [],
  educationLevels: [],
  categories: [],
  travelTypes: [],
  shiftTypes: [],
  otherFilters: [],
  keywordSearchText: "",
  location: "",
  sortOption: "",
} as const;

function searchBody(skip: number, take: number): string {
  return JSON.stringify({ skip, take, filtersForQuery: SEARCH_FILTERS });
}

const SHELL_HOST = "https://www.paycomonline.net";

function careerPageUrl(clientKeyUpper: string): string {
  return `${SHELL_HOST}/v4/ats/web.php/portal/${clientKeyUpper}/career-page`;
}

function jobUrl(jobId: string, clientKeyUpper: string): string {
  return `${SHELL_HOST}/v4/ats/web.php/jobs/ViewJobDetails?job=${encodeURIComponent(jobId)}&clientkey=${clientKeyUpper}`;
}

function trimmedOrUndefined(raw: string | null | undefined): string | undefined {
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : undefined;
}

// The salary range is a free-form display string ("$15.00 Hourly",
// "$50,000 - $70,000 Annually", "DOE"). JobSchema stores integers, so we pull
// the dollar-prefixed figures, round to the nearest whole unit, and keep the
// first as min + the second (if any) as max. No `$` figure, a zero/negative
// value, or an inverted pair → nothing emitted (drop the pair, keep the row).
export function parsePaycomSalary(raw: string | null | undefined): {
  min?: number;
  max?: number;
} {
  if (typeof raw !== "string") return {};
  const nums: number[] = [];
  for (const m of raw.matchAll(/\$\s*([0-9][0-9,]*(?:\.[0-9]+)?)/g)) {
    const n = Math.round(Number((m[1] ?? "").replace(/,/g, "")));
    if (Number.isFinite(n) && n > 0) nums.push(n);
  }
  if (nums.length === 0) return {};
  const min = nums[0] as number;
  const max = nums.length > 1 ? (nums[1] as number) : undefined;
  if (max !== undefined && min > max) return {};
  return { min, ...(max !== undefined ? { max } : {}) };
}

// Posting date: the detail `startDate` when present, else the preview's
// `postedOn` (both often blank). Normalise to UTC-Z; drop future or
// unparseable values rather than letting safeParse reject the whole row.
function postedAtFrom(
  detailDate: string | null | undefined,
  previewDate: string | null | undefined,
  observedAt: string,
): string | undefined {
  const raw = trimmedOrUndefined(detailDate) ?? trimmedOrUndefined(previewDate);
  if (raw === undefined) return undefined;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return undefined;
  const posted = d.toISOString();
  // Compare as instants (not lexically) so a millis-bearing ISO clamps
  // correctly against a non-millis observedAt.
  return Date.parse(posted) <= Date.parse(observedAt) ? posted : undefined;
}

function buildPaycomJob(
  tenantSlug: string,
  clientKeyUpper: string,
  company: string,
  observedAt: string,
  preview: PaycomPreview,
  detail: PaycomDetail | undefined,
): Job | null {
  if (preview.jobId === undefined || preview.jobId === null) return null;
  const sourceId = String(preview.jobId).trim();
  if (sourceId.length === 0) return null;

  const rawTitle = trimmedOrUndefined(preview.jobTitle);
  if (rawTitle === undefined) return null;
  // Titles occasionally carry HTML entities (`&amp;`); plainText decodes and
  // collapses them.
  const title = trimmedOrUndefined(plainText(rawTitle)) ?? rawTitle;

  const locationText =
    trimmedOrUndefined(detail?.location) ??
    trimmedOrUndefined(detail?.city) ??
    trimmedOrUndefined(preview.locations);
  const remoteHint =
    trimmedOrUndefined(detail?.remoteType) ?? trimmedOrUndefined(preview.remoteType);
  const department = trimmedOrUndefined(detail?.jobCategory);
  const descriptionHtml =
    trimmedOrUndefined(detail?.description) ?? trimmedOrUndefined(preview.description);
  const postedAt = postedAtFrom(detail?.startDate, preview.postedOn, observedAt);
  const comp = parsePaycomSalary(detail?.salaryRange);

  const candidate = buildJob({
    ats: "paycom",
    tenant_slug: tenantSlug,
    company,
    source_id: sourceId,
    title,
    url: jobUrl(sourceId, clientKeyUpper),
    ...(descriptionHtml !== undefined ? { description_html: descriptionHtml } : {}),
    ...(locationText !== undefined ? { location_text: locationText } : {}),
    // remoteType ("Remote"/"Hybrid"/"On-site") drives workplace_type; fall
    // back to inference over the title + location text.
    workplace_hint: `${remoteHint ?? ""} ${title} ${locationText ?? ""}`,
    ...(department !== undefined ? { department } : {}),
    ...(postedAt !== undefined ? { posted_at: postedAt } : {}),
    ...(comp.min !== undefined ? { compensation_min: comp.min } : {}),
    ...(comp.max !== undefined ? { compensation_max: comp.max } : {}),
    is_recruiter_post: isRecruiterTitle(title),
    first_seen_at: observedAt,
    last_seen_at: observedAt,
  });
  const validated = JobSchema.safeParse(candidate);
  return validated.success ? validated.data : null;
}

export interface ParsePaycomInput {
  readonly tenant: TenantInput;
  readonly clientKeyUpper: string;
  readonly company: string;
  readonly previews: ReadonlyArray<PaycomPreview>;
  readonly observedAt: string;
  // Detail records keyed by jobId string, when the N+1 fan-out has run.
  // Absent entries fall back to preview-only fields (no location/salary/date).
  readonly details?: ReadonlyMap<string, PaycomDetail>;
}

/**
 * Parse preview rows (merged with any fetched detail records) into
 * validated Jobs, deduped by id. Pure; deterministic.
 */
export function parsePaycomPreviews(input: ParsePaycomInput): Job[] {
  const jobs: Job[] = [];
  for (const preview of input.previews) {
    const key =
      preview.jobId === undefined || preview.jobId === null
        ? undefined
        : String(preview.jobId).trim();
    const detail = key !== undefined ? input.details?.get(key) : undefined;
    const job = buildPaycomJob(
      input.tenant.slug,
      input.clientKeyUpper,
      input.company,
      input.observedAt,
      preview,
      detail,
    );
    if (job) jobs.push(job);
  }
  return dedupeById(jobs);
}

export interface ScrapePaycomOptions {
  readonly tenant: TenantInput;
  readonly client: HttpClient;
  readonly observedAt: string;
  readonly perTenantConcurrency?: number;
  // Detail fan-out ceiling. Defaults to MAX_DETAIL_FETCH_PER_TENANT; exposed
  // so the cap is exercisable without a 500-row fixture.
  readonly maxDetailFetch?: number;
  // Search page size (skip/take). Defaults to DEFAULT_PAGE_SIZE; exposed so
  // pagination is exercisable without a 100-row fixture.
  readonly pageSize?: number;
}

export interface ScrapePaycomOutcome {
  readonly jobs: ReadonlyArray<Job>;
  readonly result: TenantResult;
}

async function fetchAllPreviews(
  opts: ScrapePaycomOptions,
  session: PaycomSession,
): Promise<{ previews: PaycomPreview[]; httpStatus: number }> {
  const take = opts.pageSize ?? DEFAULT_PAGE_SIZE;
  const searchUrl = `${session.apiBase}api/ats/job-posting-previews/search`;
  const previews: PaycomPreview[] = [];
  let skip = 0;
  let count = Number.POSITIVE_INFINITY;
  let full = true; // whether the last page filled `take` (more may follow)
  let pages = 0;
  let httpStatus = 200;
  // The `/api/ats/job-posting-previews/search` list endpoint is a documented
  // public read-only JSON API. The pod host publishes `Disallow: /` in
  // robots.txt — written for general crawlers, not this API — so we treat it
  // as an API call (skipRobots), the same rationale the probe pass uses for
  // `Disallow: /` API hosts.
  do {
    const res = await opts.client.request(searchUrl, {
      method: "POST",
      skipRobots: true,
      headers: {
        authorization: `Bearer ${session.sessionJWT}`,
        "content-type": "application/json",
      },
      body: searchBody(skip, take),
    });
    httpStatus = res.status;
    const body = (await res.json()) as PaycomSearchResponse;
    const page = Array.isArray(body.jobPostingPreviews) ? body.jobPostingPreviews : [];
    previews.push(...page);
    count =
      typeof body.jobPostingPreviewsCount === "number" && body.jobPostingPreviewsCount >= 0
        ? body.jobPostingPreviewsCount
        : count;
    // A short (or empty) page is the last one — the definitive terminator when
    // the server omits or under-reports the count. Otherwise keep going while
    // the reported count says more remain.
    full = page.length === take;
    skip += take;
    pages += 1;
  } while (full && skip < count && pages < MAX_SEARCH_PAGES);
  return { previews, httpStatus };
}

async function fetchDetails(
  opts: ScrapePaycomOptions,
  session: PaycomSession,
  previews: ReadonlyArray<PaycomPreview>,
): Promise<{ details: Map<string, PaycomDetail>; capped: boolean; total: number; cap: number }> {
  const cap = opts.maxDetailFetch ?? MAX_DETAIL_FETCH_PER_TENANT;
  const withId = previews.filter((p) => p.jobId !== undefined && p.jobId !== null);
  const toFetch = withId.slice(0, cap);
  const details = new Map<string, PaycomDetail>();
  const limit = pLimit(opts.perTenantConcurrency ?? DEFAULT_PER_TENANT_CONCURRENCY);
  await Promise.all(
    toFetch.map((p) =>
      limit(async () => {
        const id = String(p.jobId).trim();
        if (id.length === 0) return;
        try {
          // The detail path `api/ats/job-postings/` is in fact an explicit
          // `Allow:` in the pod's robots.txt (unlike the sibling search
          // endpoint, which the blanket `Disallow: /` covers). We set
          // skipRobots uniformly with the search call anyway — both are the
          // same documented public JSON API surface — so the fan-out never
          // pays a per-detail robots lookup.
          const res = await opts.client.request(
            `${session.apiBase}api/ats/job-postings/${encodeURIComponent(id)}`,
            { skipRobots: true, headers: { authorization: `Bearer ${session.sessionJWT}` } },
          );
          const body = (await res.json()) as PaycomDetailResponse;
          if (body.jobPosting && typeof body.jobPosting === "object") {
            details.set(id, body.jobPosting);
          }
        } catch {
          // Detail is enrichment only — a failed detail GET leaves the row
          // built from preview-only fields rather than dropping it.
        }
      }),
    ),
  );
  return { details, capped: withId.length > cap, total: withId.length, cap };
}

export async function scrapePaycomTenant(opts: ScrapePaycomOptions): Promise<ScrapePaycomOutcome> {
  try {
    assertSafeSlug(opts.tenant.slug);
    if (!CLIENTKEY_RE.test(opts.tenant.slug)) {
      return {
        jobs: [],
        result: {
          slug: opts.tenant.slug,
          status: "dead",
          error: "paycom slug is not a 32-hex clientkey",
          jobs_count: 0,
        },
      };
    }
    const clientKeyUpper = opts.tenant.slug.toUpperCase();
    const company = opts.tenant.display_name ?? opts.tenant.slug;

    // Step 1: GET the career page (robots-Allowed on www.paycomonline.net) to
    // discover the auto-issued JWT + per-tenant API base. A dead/unknown
    // clientkey serves a placeholder with no configsFromHost.
    const shellRes = await opts.client.request(careerPageUrl(clientKeyUpper));
    const html = await shellRes.text();
    const session = extractPaycomSession(html);
    if (session === null) {
      return {
        jobs: [],
        result: {
          slug: opts.tenant.slug,
          status: "dead",
          http_status: shellRes.status,
          error: "no configsFromHost session (missing JWT / API base, or SSRF-rejected host)",
          jobs_count: 0,
        },
      };
    }

    // Step 2: paginate the list search.
    const { previews, httpStatus } = await fetchAllPreviews(opts, session);

    // Step 3: bounded N+1 detail fan-out for location/salary/date.
    const { details, capped, total, cap } = await fetchDetails(opts, session, previews);

    const jobs = parsePaycomPreviews({
      tenant: opts.tenant,
      clientKeyUpper,
      company,
      previews,
      observedAt: opts.observedAt,
      details,
    });

    return {
      jobs,
      result: {
        slug: opts.tenant.slug,
        status: "success",
        http_status: httpStatus,
        ...(capped ? { error: `capped at ${cap} of ${total} roles` } : {}),
        jobs_count: jobs.length,
      },
    };
  } catch (err) {
    return { jobs: [], result: errorToResult(opts.tenant.slug, err) };
  }
}
