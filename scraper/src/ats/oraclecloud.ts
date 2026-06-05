import { type Job, JobSchema, jobId, type TenantInput, type TenantResult } from "@openroles/shared";
import type { HttpClient } from "../http.ts";
import { excerpt, normalizeWorkplace, plainText, splitLocation } from "../normalize.ts";
import {
  assertOracleHost,
  assertOracleSite,
  assertSafeSlug,
  dedupeById,
  errorToResult,
  isRecruiterTitle,
  vendorDateToIsoZ,
} from "./common.ts";

// A single requisition row as returned in `items[0].requisitionList[]` by
// the public Candidate Experience search resource. The listing already
// carries `ShortDescriptionStr` (a clean summary blurb), so no per-job
// detail fetch is needed — one request per page covers title, location,
// workplace type, department and excerpt.
interface OracleRequisition {
  Id?: string | null;
  Title?: string | null;
  PostedDate?: string | null;
  PrimaryLocation?: string | null;
  PrimaryLocationCountry?: string | null;
  ShortDescriptionStr?: string | null;
  JobFamily?: string | null;
  WorkplaceTypeCode?: string | null;
}

interface OracleSearchItem {
  TotalJobsCount?: number;
  requisitionList?: ReadonlyArray<OracleRequisition>;
}

interface OracleResponse {
  items?: ReadonlyArray<OracleSearchItem>;
}

const PAGE_SIZE = 100;
// 6,000-requisition ceiling per tenant. The largest public Oracle career
// sites carry a few thousand reqs; this bounds the per-tenant fan-out so a
// single mega-tenant cannot blow the matrix runner's time budget while
// still covering every real-world site in full.
const MAX_PAGES = 60;

// Map Oracle's workplace taxonomy to the canonical workplace_type. Codes are
// matched by substring (`ORA_REMOTE`, `ORA_HYBRID`, `ORA_ONSITE`) so the
// mapping is robust to the prefix Oracle versions across releases. When a
// tenant leaves the field blank (common — many sites never set it), fall
// back to scanning the title/location text for a remote/hybrid/onsite hint.
function workplaceFromCode(
  code: string | null | undefined,
  fallbackHint: string,
): Job["workplace_type"] {
  const c = typeof code === "string" ? code.toUpperCase() : "";
  if (c.includes("REMOTE")) return "remote";
  if (c.includes("HYBRID")) return "hybrid";
  if (c.includes("ONSITE")) return "onsite";
  return normalizeWorkplace(fallbackHint);
}

// ShortDescriptionStr is HTML and may carry raw newlines; plainText strips
// tags, decodes entities and collapses whitespace — without it the control
// characters would fail JobSchema's excerpt validation and drop the row.
function oracleDescription(raw: string | null | undefined): string | undefined {
  const text = raw ? plainText(raw) : "";
  return text.length > 0 ? excerpt(text) : undefined;
}

function oracleCountry(raw: string | null | undefined): string | undefined {
  const upper = typeof raw === "string" ? raw.toUpperCase() : "";
  return /^[A-Z]{2}$/.test(upper) ? upper : undefined;
}

function trimmedOrUndefined(raw: string | null | undefined): string | undefined {
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : undefined;
}

// PostedDate is date-only (`2026-06-05`) → normalises to 00:00:00Z, which is
// always <= the observedAt timestamp for a same-day posting. Drop any value
// that would violate the schema's posted_at <= last_seen_at rule rather than
// letting safeParse reject the whole row.
function oraclePostedAt(raw: string | null | undefined, observedAt: string): string | undefined {
  const posted = vendorDateToIsoZ(raw);
  return posted && posted <= observedAt ? posted : undefined;
}

function requisitionToJob(
  tenantSlug: string,
  company: string,
  host: string,
  site: string,
  observedAt: string,
  r: OracleRequisition,
): Job | null {
  if (!r.Id || !r.Title) return null;
  const sourceId = r.Id;
  // Canonical Candidate Experience job-card URL. `/sites/{site}/job/{id}`
  // renders the specific requisition (HTTP 200); the (host, site, id) triple
  // is the unique address Oracle Recruiting assigns a posting, and is the
  // exact link the public careers SPA deep-links to. Verified live across
  // multiple tenants.
  const url = `https://${host}/hcmUI/CandidateExperience/en/sites/${site}/job/${sourceId}`;
  const id = jobId({ ats: "oraclecloud", tenant_slug: tenantSlug, source_id: sourceId, url });

  const locationText = trimmedOrUndefined(r.PrimaryLocation);
  const region = locationText ? splitLocation(locationText).region : undefined;
  const country = oracleCountry(r.PrimaryLocationCountry);
  const description = oracleDescription(r.ShortDescriptionStr);
  const department = trimmedOrUndefined(r.JobFamily);
  const postedAt = oraclePostedAt(r.PostedDate, observedAt);

  const candidate = {
    id,
    ats: "oraclecloud",
    tenant_slug: tenantSlug,
    source_id: sourceId,
    title: r.Title,
    company,
    level: null,
    level_rank: null,
    workplace_type: workplaceFromCode(r.WorkplaceTypeCode, `${r.Title} ${locationText ?? ""}`),
    is_recruiter_post: isRecruiterTitle(r.Title),
    ...(description ? { description_excerpt: description } : {}),
    ...(locationText ? { location_text: locationText } : {}),
    ...(country ? { location_country: country } : {}),
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

export interface ParseOracleRequisitionsInput {
  readonly tenant: TenantInput;
  readonly company: string;
  readonly host: string;
  readonly site: string;
  readonly response: unknown;
  readonly observedAt: string;
}

// Pure parser over one CE search-response page: `items[0].requisitionList[]`
// → validated Jobs, deduped by id. Decoupled from HTTP so it can be
// fixture-replayed and property-tested deterministically.
export function parseOracleRequisitions(input: ParseOracleRequisitionsInput): Job[] {
  const body = input.response as OracleResponse;
  const list = body.items?.[0]?.requisitionList ?? [];
  const jobs: Job[] = [];
  for (const r of list) {
    const job = requisitionToJob(
      input.tenant.slug,
      input.company,
      input.host,
      input.site,
      input.observedAt,
      r,
    );
    if (job) jobs.push(job);
  }
  return dedupeById(jobs);
}

export interface ScrapeOracleCloudOptions {
  readonly tenant: TenantInput;
  readonly client: HttpClient;
  readonly observedAt: string;
  // Per-tenant Fusion pod host + Candidate Experience site code. Both are
  // mandatory and not slug-derivable, so the dispatcher marks tenants
  // missing either field as dead (mirrors the workday host/site pattern).
  readonly host: string;
  readonly site: string;
}

export interface ScrapeOracleCloudOutcome {
  readonly jobs: ReadonlyArray<Job>;
  readonly result: TenantResult;
}

export async function scrapeOracleCloudTenant(
  opts: ScrapeOracleCloudOptions,
): Promise<ScrapeOracleCloudOutcome> {
  try {
    assertSafeSlug(opts.tenant.slug);
    assertOracleHost(opts.host);
    assertOracleSite(opts.site);
    const company = opts.tenant.display_name ?? opts.tenant.slug;
    const jobs: Job[] = [];
    let httpStatus = 0;
    let total = Number.POSITIVE_INFINITY;

    for (let page = 0; page < MAX_PAGES; page++) {
      const offset = page * PAGE_SIZE;
      if (offset >= total) break;
      // Oracle ADF rejects top-level limit/offset/sortBy params ("cannot be
      // used in this context") — they must live inside the finder. The
      // `expand=requisitionList...` param is mandatory; without it the
      // response carries only search-facet metadata and no job list.
      const finder = `findReqs;siteNumber=${opts.site},limit=${PAGE_SIZE},offset=${offset},sortBy=POSTING_DATES_DESC`;
      const url = `https://${opts.host}/hcmRestApi/resources/latest/recruitingCEJobRequisitions?onlyData=true&expand=requisitionList.workLocation,requisitionList.secondaryLocations&finder=${finder}`;
      const res = await opts.client.request(url);
      httpStatus = res.status;
      const body = (await res.json()) as OracleResponse;
      const item = body.items?.[0];
      if (!item) break;
      if (typeof item.TotalJobsCount === "number") total = item.TotalJobsCount;
      const pageCount = item.requisitionList?.length ?? 0;
      for (const job of parseOracleRequisitions({
        tenant: opts.tenant,
        company,
        host: opts.host,
        site: opts.site,
        response: body,
        observedAt: opts.observedAt,
      })) {
        jobs.push(job);
      }
      if (pageCount < PAGE_SIZE) break;
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
