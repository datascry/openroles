import { type Job, JobSchema, type TenantInput, type TenantResult } from "@openroles/shared";
import { z } from "zod";
import { buildJob } from "../build-job.ts";
import type { HttpClient } from "../http.ts";
import { assertSafeSlug, dedupeById, errorToResult, isRecruiterTitle } from "./common.ts";

// Oracle Taleo Enterprise career sections are JSF/FTL apps. The browser-
// rendered job list is populated by a JSON XHR call from
// `careersection_all/2025PRD.x.x.x.x/js/facetedsearch/SearchHandler.js`:
//
//   POST /careersection/rest/jobboard/searchjobs?lang=en&portal={portalNo}
//   Content-Type: application/json
//   { "multilineEnabled": true, "pageNo": N, ... }
//
// The endpoint is public — no cookies, no CSRF token required when called
// programmatically. The wrinkle is the `portalNo`: it's a per-section
// numeric id (different for the "External", "Professional", "Internal"
// sections) and the public-facing one is only declared inline in the
// section's `jobsearch.ftl` HTML as `portalNo: '<digits>'` inside the
// require.config bundle. Without a valid `portalNo` the search endpoint
// returns `careerSectionUnAvailable: true`.
//
// Discovery: the slugs we collected in harvest don't carry any section
// hint, so we probe sections 1..3 in order and use the first one whose
// HTML embeds a portalNo. Section 1 wins for ~all observed live tenants
// (edmonton, adb, agnicoeagle, axp). When no section yields a portalNo
// we surface success/0 jobs — the tenant exists but the public board is
// closed (e.g. the Oracle Cloud cutover banner: "This site is no longer
// active"; or all sections return the "Career Section Unavailable"
// placeholder).
//
// The TBE pool (`{pod}.tbe.taleo.net`) is a separate product with its
// own board surface and composite tenancy (host/instance/cws + org),
// handled by the sibling `taleotbe` adapter in ./taleotbe.ts.

const TaleoJob = z
  .object({
    jobId: z.union([z.string(), z.number()]),
    contestNo: z.union([z.string(), z.number()]).optional(),
    column: z.array(z.string()).optional(),
    locationsColumns: z.array(z.number()).optional(),
  })
  .passthrough();

const TaleoPagingData = z
  .object({
    currentPageNo: z.number().int(),
    pageSize: z.number().int(),
    totalCount: z.number().int(),
  })
  .passthrough();

const TaleoSearchResponse = z
  .object({
    requisitionList: z.union([z.array(TaleoJob), z.null()]).optional(),
    pagingData: z.union([TaleoPagingData, z.null()]).optional(),
    careerSectionUnAvailable: z.boolean().optional(),
  })
  .passthrough();

type TaleoJobRaw = z.infer<typeof TaleoJob>;

// Sections to probe in order. Section "1" is the public External board on
// every observed live tenant (~all named-corp slugs in our list); "2" is a
// common fallback (often the Internal/Professional board). We do not probe
// further to keep per-tenant request cost ≤4 (3 GETs + ≥1 POST).
const SECTIONS_TO_PROBE: ReadonlyArray<string> = ["1", "2", "3"];

const PORTAL_NO_RE = /portalNo\s*:\s*'([0-9]{1,32})'/;

// The placeholder error page Taleo serves when a section id is reserved
// but not actually published. ~1.4 KB, returns 200, contains this exact
// title — distinct from the real `<title>Job Search</title>` of a live
// section.
const UNAVAILABLE_TITLE_RE = /<title>\s*Career Section Unavailable\s*<\/title>/i;

/**
 * Pull the `portalNo: '12345'` declaration out of a Taleo section's
 * jobsearch.ftl HTML. Returns undefined when the page is the "Career
 * Section Unavailable" placeholder or when the bundle is missing the
 * declaration (tenants on a non-standard theme).
 */
export function extractTaleoPortalNo(html: string): string | undefined {
  if (UNAVAILABLE_TITLE_RE.test(html)) return undefined;
  const match = html.match(PORTAL_NO_RE);
  return match?.[1];
}

interface DiscoveredSection {
  readonly section: string;
  readonly portalNo: string;
}

/**
 * Walk SECTIONS_TO_PROBE in order, GET each `/careersection/<sec>/jobsearch.ftl`
 * page, and return the first one whose HTML carries a `portalNo` — that's
 * the section we'll search against. Returns undefined if no section yields
 * one (tenant is harvested-historical but the public board is now closed).
 */
async function discoverSection(
  client: HttpClient,
  slug: string,
): Promise<DiscoveredSection | undefined> {
  for (const section of SECTIONS_TO_PROBE) {
    const url = `https://${slug}.taleo.net/careersection/${section}/jobsearch.ftl?lang=en`;
    let res: Response;
    try {
      res = await client.request(url, { method: "GET" });
    } catch {
      // A single section returning 404 / 5xx doesn't mean the tenant is
      // dead — sections are independent. Try the next one.
      continue;
    }
    const html = await res.text();
    const portalNo = extractTaleoPortalNo(html);
    if (portalNo !== undefined) return { section, portalNo };
  }
  return undefined;
}

/**
 * Pull a job's location text out of `column[locationsColumns[0]]`. The
 * value is either a JSON-stringified array of locations
 * (`["London","Remote - UK"]`) or a plain string (`"Toronto, Ontario"`).
 * Returns undefined when no location column is configured for the tenant
 * or the indicated cell is empty.
 */
export function taleoLocationText(job: TaleoJobRaw): string | undefined {
  const columns = job.column;
  const locIdxs = job.locationsColumns;
  if (!Array.isArray(columns) || !Array.isArray(locIdxs) || locIdxs.length === 0) {
    return undefined;
  }
  const idx = locIdxs[0];
  if (idx === undefined || idx < 0 || idx >= columns.length) return undefined;
  const cell = columns[idx];
  if (typeof cell !== "string" || cell.length === 0) return undefined;
  // Some tenants stringify the location list as a JSON array; others put
  // a single comma-separated string. Try JSON first; on parse failure,
  // fall back to the raw cell.
  if (cell.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(cell);
      if (Array.isArray(parsed)) {
        const strings = parsed.filter((v): v is string => typeof v === "string" && v.length > 0);
        if (strings.length > 0) return strings.join(", ");
      }
    } catch {
      // fall through to the raw cell
    }
  }
  return cell;
}

export interface TaleoParseInput {
  readonly tenant: TenantInput;
  readonly company: string;
  readonly section: string;
  readonly response: unknown;
  readonly observedAt: string;
}

export function parseTaleoJobs(input: TaleoParseInput): Job[] {
  const parsed = TaleoSearchResponse.parse(input.response);
  if (parsed.careerSectionUnAvailable === true) return [];
  const list = parsed.requisitionList ?? [];
  const jobs: Job[] = [];
  for (const raw of list) {
    const sourceId = String(raw.jobId);
    if (sourceId.length === 0) continue;
    const title = raw.column?.[0]?.trim();
    if (!title) continue;
    const locationText = taleoLocationText(raw);
    const url = `https://${input.tenant.slug}.taleo.net/careersection/${input.section}/jobdetail.ftl?job=${sourceId}&lang=en`;
    const candidate = buildJob({
      ats: "taleo",
      tenant_slug: input.tenant.slug,
      company: input.company,
      source_id: sourceId,
      title,
      url,
      ...(locationText !== undefined ? { location_text: locationText } : {}),
      workplace_hint: locationText ?? "",
      is_recruiter_post: isRecruiterTitle(title),
      first_seen_at: input.observedAt,
      last_seen_at: input.observedAt,
    });
    const validated = JobSchema.safeParse(candidate);
    if (validated.success) jobs.push(validated.data);
  }
  return dedupeById(jobs);
}

export interface ScrapeTaleoOptions {
  readonly tenant: TenantInput;
  readonly client: HttpClient;
  readonly observedAt: string;
  readonly maxPages?: number;
}

export interface ScrapeTaleoOutcome {
  readonly jobs: ReadonlyArray<Job>;
  readonly result: TenantResult;
}

const DEFAULT_MAX_PAGES = 200;

interface PageFetchResult {
  readonly httpStatus: number;
  readonly careerSectionUnAvailable: boolean;
  readonly listLength: number;
  readonly pageSize: number;
  readonly totalCount: number;
  readonly jobs: ReadonlyArray<Job>;
}

async function fetchTaleoPage(
  opts: ScrapeTaleoOptions,
  discovered: DiscoveredSection,
  pageNo: number,
  company: string,
): Promise<PageFetchResult> {
  const url = `https://${opts.tenant.slug}.taleo.net/careersection/rest/jobboard/searchjobs?lang=en&portal=${discovered.portalNo}`;
  const res = await opts.client.request(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      tz: "GMT",
    },
    body: JSON.stringify({ multilineEnabled: true, pageNo }),
  });
  const body = await res.json();
  const parsedShape = TaleoSearchResponse.parse(body);
  if (parsedShape.careerSectionUnAvailable === true) {
    return {
      httpStatus: res.status,
      careerSectionUnAvailable: true,
      listLength: 0,
      pageSize: 0,
      totalCount: 0,
      jobs: [],
    };
  }
  const pageJobs = parseTaleoJobs({
    tenant: opts.tenant,
    company,
    section: discovered.section,
    response: body,
    observedAt: opts.observedAt,
  });
  return {
    httpStatus: res.status,
    careerSectionUnAvailable: false,
    listLength: parsedShape.requisitionList?.length ?? 0,
    pageSize: parsedShape.pagingData?.pageSize ?? 0,
    totalCount: parsedShape.pagingData?.totalCount ?? 0,
    jobs: pageJobs,
  };
}

export async function scrapeTaleoTenant(opts: ScrapeTaleoOptions): Promise<ScrapeTaleoOutcome> {
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
  try {
    assertSafeSlug(opts.tenant.slug);
    const discovered = await discoverSection(opts.client, opts.tenant.slug);
    if (!discovered) {
      // Tenant exists (one of the sections returned 200 with the
      // placeholder page, or all returned 404) but no public section
      // currently publishes jobs. Surface success/0 — the row stays
      // crawlable for tomorrow's pass without poisoning the corpus.
      return {
        jobs: [],
        result: { slug: opts.tenant.slug, status: "success", jobs_count: 0 },
      };
    }
    const company = opts.tenant.display_name ?? opts.tenant.slug;
    const collected: Job[] = [];
    let lastStatus = 0;
    let careerSectionUnAvailable = false;
    for (let pageNo = 1; pageNo <= maxPages; pageNo++) {
      const page = await fetchTaleoPage(opts, discovered, pageNo, company);
      lastStatus = page.httpStatus;
      if (page.careerSectionUnAvailable) {
        careerSectionUnAvailable = true;
        break;
      }
      for (const j of page.jobs) collected.push(j);
      // Stop when this page held fewer rows than pageSize (last page) or
      // when we've covered the declared total. Some tenants advertise a
      // higher totalCount than they return (multilingual duplicates) — a
      // short page is the authoritative end-of-list signal either way.
      if (page.listLength === 0) break;
      if (page.pageSize > 0 && page.listLength < page.pageSize) break;
      if (page.totalCount > 0 && pageNo * page.pageSize >= page.totalCount) break;
    }
    const jobs = dedupeById(collected);
    return {
      jobs,
      result: {
        slug: opts.tenant.slug,
        status: "success",
        ...(lastStatus > 0 ? { http_status: lastStatus } : {}),
        ...(careerSectionUnAvailable
          ? { error: "careerSectionUnAvailable: true (portal closed)" }
          : {}),
        jobs_count: jobs.length,
      },
    };
  } catch (err) {
    return { jobs: [], result: errorToResult(opts.tenant.slug, err) };
  }
}
