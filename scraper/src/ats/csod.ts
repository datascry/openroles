import { type Job, JobSchema, type TenantInput, type TenantResult } from "@openroles/shared";
import { buildJob } from "../build-job.ts";
import { type HttpClient, HttpError } from "../http.ts";
import { assertSafeSlug, dedupeById, errorToResult, isRecruiterTitle } from "./common.ts";

// Cornerstone OnDemand (CSOD / Cornerstone Talent Experience Suite) exposes
// an anonymous careersite search API at
//   POST https://{slug}.csod.com/services/x/career-site/v1/search
// Each request needs a short-lived JWT bearer token plus the careersite id
// (an integer per tenant), neither of which we know up-front. The bootstrap
// flow:
//   1. GET https://{slug}.csod.com/ats/careersite/search.aspx?site=1&c={slug}
//      Modern tenants 302 to /ux/ats/careersite/{csid}/home?c={slug}; the
//      final URL carries the integer careersite id, and the home page HTML
//      embeds csod.context = { token, cultureID, cultureName, ... } in an
//      inline <script>.
//   2. Extract token + cultureId/cultureName from that HTML.
//   3. POST the search payload — the API expects a fully-populated
//      buildSearchRequest envelope (careerSiteId/PageId, pagination,
//      culture, and empty filter arrays); a thinner body returns 400.
//
// Tenants whose careersite is gated behind SSO (samldefault.aspx,
// globalsso/gssosamldefault.aspx, login/render.aspx, RestrictedArea.aspx)
// land on those URLs after the first hop instead of the /ux/ careersite,
// and surface as `dead` here — no public job listing is reachable.

interface CsodLocation {
  readonly city?: string | null;
  readonly state?: string | null;
  readonly country?: string | null;
}

interface CsodRequisition {
  readonly requisitionId?: number | string;
  readonly displayJobTitle?: string;
  readonly postingEffectiveDate?: string;
  readonly postingExpirationDate?: string;
  readonly ouTitle?: string;
  readonly ouFullPath?: string;
  readonly locations?: ReadonlyArray<CsodLocation>;
}

interface CsodSearchData {
  readonly totalCount?: number | null;
  readonly requisitions?: ReadonlyArray<CsodRequisition>;
}

interface CsodSearchResponse {
  readonly status?: number;
  readonly data?: CsodSearchData;
}

const TOKEN_RE = /"token"\s*:\s*"([A-Za-z0-9_\-.]+)"/;
const CULTURE_ID_RE = /"cultureID"\s*:\s*(\d+)/;
const CULTURE_NAME_RE = /"cultureName"\s*:\s*"([A-Za-z0-9_-]+)"/;
const CAREERSITE_ID_RE = /\/ux\/ats\/careersite\/(\d+)\/home\b/;

// JWTs from CSOD are JSON Web Tokens (header.payload.signature) so the
// character class is restricted to base64url + dots. Cap the length to
// guard against pathological inline blobs while still admitting the
// ~2KB tokens we observe in production.
const MAX_TOKEN_LEN = 8192;

const ISO2 = /^[A-Z]{2}$/;

function locationText(loc: CsodLocation | undefined): string | undefined {
  if (!loc) return undefined;
  const parts = [loc.city, loc.state, loc.country].filter(
    (s): s is string => typeof s === "string" && s.length > 0,
  );
  return parts.length > 0 ? parts.join(", ") : undefined;
}

function locationCountry(loc: CsodLocation | undefined): string | undefined {
  const c = loc?.country;
  if (typeof c !== "string") return undefined;
  return ISO2.test(c) ? c : undefined;
}

function toIsoZ(value: string | undefined): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  // CSOD returns `2026-04-15T00:00:00` (no zone); treat it as UTC. Other
  // shapes (e.g. `04-05-2026`) drop through and Date.parse handles only the
  // ISO-like ones. Locale-formatted strings return undefined rather than
  // get misinterpreted as MM-DD-YYYY in non-US locales.
  const candidate = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(value) ? `${value}Z` : value;
  const d = new Date(candidate);
  if (Number.isNaN(d.getTime())) return undefined;
  // Reject parses of obviously locale-formatted DD-MM-YYYY strings — those
  // are dropped entirely rather than risk swapping day/month.
  if (!/^\d{4}-\d{2}-\d{2}/.test(value)) return undefined;
  return d.toISOString();
}

interface CareerSiteContext {
  readonly careerSiteId: number;
  readonly token: string;
  readonly cultureId: number;
  readonly cultureName: string;
}

export function parseCareerSiteContext(args: {
  readonly finalUrl: string;
  readonly html: string;
}): CareerSiteContext | null {
  const csidMatch = CAREERSITE_ID_RE.exec(args.finalUrl);
  if (!csidMatch?.[1]) return null;
  const careerSiteId = Number.parseInt(csidMatch[1], 10);
  if (!Number.isFinite(careerSiteId)) return null;

  const tokenMatch = TOKEN_RE.exec(args.html);
  if (!tokenMatch?.[1]) return null;
  const token = tokenMatch[1];
  if (token.length === 0 || token.length > MAX_TOKEN_LEN) return null;

  const cultureIdMatch = CULTURE_ID_RE.exec(args.html);
  const cultureId = cultureIdMatch?.[1] ? Number.parseInt(cultureIdMatch[1], 10) : 1;

  const cultureNameMatch = CULTURE_NAME_RE.exec(args.html);
  const cultureName = cultureNameMatch?.[1] ?? "en-US";

  return { careerSiteId, token, cultureId, cultureName };
}

function buildSearchBody(ctx: CareerSiteContext, pageNumber: number, pageSize: number): string {
  return JSON.stringify({
    careerSiteId: ctx.careerSiteId,
    careerSitePageId: ctx.careerSiteId,
    pageNumber,
    pageSize,
    cultureId: ctx.cultureId,
    cultureName: ctx.cultureName,
    searchText: "",
    states: [],
    countryCodes: [],
    cities: [],
    placeID: "",
    radius: 0,
    postingsWithinDays: 0,
    customFieldCheckboxKeys: [],
    customFieldDropdowns: [],
    customFieldRadios: [],
  });
}

export interface CsodParseInput {
  readonly tenant: TenantInput;
  readonly company: string;
  readonly slug: string;
  readonly careerSiteId: number;
  readonly response: CsodSearchResponse;
  readonly observedAt: string;
}

function buildCsodJob(r: CsodRequisition, input: CsodParseInput): Job | null {
  const reqId = r.requisitionId;
  if (reqId === undefined || reqId === null) return null;
  const sourceId = String(reqId);
  if (sourceId.length === 0) return null;
  const title = r.displayJobTitle;
  if (typeof title !== "string" || title.trim().length === 0) return null;
  const url = `https://${input.slug}.csod.com/ux/ats/careersite/${input.careerSiteId}/requisition/${sourceId}?c=${input.slug}`;
  const firstLoc = r.locations?.[0];
  const locText = locationText(firstLoc);
  const country = locationCountry(firstLoc);
  const postedIso = toIsoZ(r.postingEffectiveDate);
  const candidate = buildJob({
    ats: "csod",
    tenant_slug: input.tenant.slug,
    company: input.company,
    source_id: sourceId,
    title,
    url,
    ...(locText !== undefined ? { location_text: locText } : {}),
    workplace_hint: locText ?? "",
    ...(r.ouTitle ? { department: r.ouTitle } : {}),
    ...(postedIso !== undefined ? { posted_at: postedIso } : {}),
    is_recruiter_post: isRecruiterTitle(title),
    first_seen_at: input.observedAt,
    last_seen_at: input.observedAt,
  });
  const enriched: Job = country ? { ...candidate, location_country: country } : candidate;
  const validated = JobSchema.safeParse(enriched);
  return validated.success ? validated.data : null;
}

export function parseCsodRequisitions(input: CsodParseInput): Job[] {
  const reqs = input.response.data?.requisitions ?? [];
  const jobs: Job[] = [];
  for (const r of reqs) {
    const job = buildCsodJob(r, input);
    if (job) jobs.push(job);
  }
  return dedupeById(jobs);
}

export interface ScrapeCsodOptions {
  readonly tenant: TenantInput;
  readonly client: HttpClient;
  readonly observedAt: string;
  readonly pageSize?: number;
  readonly maxPages?: number;
}

export interface ScrapeCsodOutcome {
  readonly jobs: ReadonlyArray<Job>;
  readonly result: TenantResult;
}

const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_MAX_PAGES = 200;

export async function scrapeCsodTenant(opts: ScrapeCsodOptions): Promise<ScrapeCsodOutcome> {
  const pageSize = opts.pageSize ?? DEFAULT_PAGE_SIZE;
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
  let lastStatus = 0;
  try {
    assertSafeSlug(opts.tenant.slug);
    const slug = opts.tenant.slug;
    // The legacy `/ats/careersite/search.aspx` URL is the canonical entry
    // point — modern tenants 302 to `/ux/ats/careersite/{csid}/home`,
    // legacy ones land on a login wall (samldefault.aspx, RestrictedArea,
    // login/render.aspx) which we treat as `dead`.
    const bootstrapUrl = `https://${slug}.csod.com/ats/careersite/search.aspx?site=1&c=${slug}`;
    const homeRes = await opts.client.request(bootstrapUrl);
    lastStatus = homeRes.status;
    const finalUrl = homeRes.url;
    const html = await homeRes.text();
    const ctx = parseCareerSiteContext({ finalUrl, html });
    if (!ctx) {
      // Either SSO-gated, an old non-`/ux` careersite, or the page shape
      // changed — `permanent` so the tenant gets reclassified as `dead`
      // rather than retried indefinitely.
      throw new HttpError(
        "permanent",
        `csod careersite bootstrap unparseable for ${slug} (final url ${finalUrl})`,
      );
    }
    const searchUrl = `https://${slug}.csod.com/services/x/career-site/v1/search`;
    const collected: Job[] = [];
    let total = Number.POSITIVE_INFINITY;
    for (let page = 1; page <= maxPages; page++) {
      if ((page - 1) * pageSize >= total) break;
      const res = await opts.client.request(searchUrl, {
        method: "POST",
        body: buildSearchBody(ctx, page, pageSize),
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          authorization: `Bearer ${ctx.token}`,
        },
      });
      lastStatus = res.status;
      const body = (await res.json()) as CsodSearchResponse;
      const data = body.data;
      if (!data || !Array.isArray(data.requisitions)) {
        throw new HttpError("transient", `csod search response missing data for ${slug}`);
      }
      total = typeof data.totalCount === "number" ? data.totalCount : data.requisitions.length;
      const pageJobs = parseCsodRequisitions({
        tenant: opts.tenant,
        company: opts.tenant.display_name ?? opts.tenant.slug,
        slug,
        careerSiteId: ctx.careerSiteId,
        response: body,
        observedAt: opts.observedAt,
      });
      for (const j of pageJobs) collected.push(j);
      if (data.requisitions.length < pageSize) break;
    }
    const jobs = dedupeById(collected);
    return {
      jobs,
      result: {
        slug: opts.tenant.slug,
        status: "success",
        http_status: lastStatus,
        jobs_count: jobs.length,
      },
    };
  } catch (err) {
    return { jobs: [], result: errorToResult(opts.tenant.slug, err) };
  }
}
