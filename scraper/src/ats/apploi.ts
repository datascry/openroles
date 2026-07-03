import { type Job, JobSchema, type TenantInput, type TenantResult } from "@openroles/shared";
import { buildJob } from "../build-job.ts";
import { type HttpClient, HttpError } from "../http.ts";
import { decodeHtmlEntities } from "../normalize.ts";
import {
  assertSafeSlug,
  dedupeById,
  errorToResult,
  isRecruiterTitle,
  vendorDateToIsoZ,
} from "./common.ts";

// Apploi job platform (healthcare-heavy multi-brand hiring). Every brand
// shares one public search API:
//
//   GET https://ats-integrations.apploi.com/search/jobs/?page=N&size=100&brand={brand}
//
// The listing rows already carry the full HTML description, salary fields
// and publish date, so one request per page covers everything — no per-job
// detail fan-out. The public job card lives at jobs.apploi.com/view/{id}.
//
// The `brand` parameter is a relevance *search*, not a strict filter: once
// a brand's own rows are exhausted the API keeps returning full pages of
// lower-scored rows from unrelated brands (verified live — page 2 of a
// ~115-role brand was 15 exact rows followed by 85 foreign ones, and an
// unknown brand string still returned somebody else's posting). The adapter
// therefore keeps only rows whose `brand_name` equals the tenant's
// metadata.brand exactly, and treats the first page containing any foreign
// row — or no exact row at all — as the exhaustion boundary (exact matches
// always outscore fuzzy ones, so they sort first).

interface ApploiRow {
  id?: string | number | null;
  name?: string | null;
  brand_name?: string | null;
  city?: string | null;
  state?: string | null;
  published_date?: string | null;
  description?: string | null;
  salary_min?: number | null;
  salary_max?: number | null;
}

interface ApploiResponse {
  data?: ReadonlyArray<ApploiRow | null>;
}

const PAGE_SIZE = 100;
// 3,000-role ceiling per brand. Apploi brands are facility- or
// health-system-scoped (the largest verified seed carries ~115 roles), so
// the cap bounds a runaway relevance loop without ever truncating a real
// tenant.
const MAX_PAGES = 30;
const SEARCH_URL = "https://ats-integrations.apploi.com/search/jobs/";

// Brand strings are verbatim operator-seeded display names ("University
// Health", "The Laurels of Blanchester"). They flow into a query parameter
// (URL-encoded) and into TenantResult errors, so reject empties, control
// characters and anything longer than the tenant-metadata value ceiling.
function assertApploiBrand(brand: string): void {
  if (
    brand.trim().length === 0 ||
    brand.length > 256 ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: rejects control chars in an operator-seeded query value
    /[\x00-\x1f\x7f]/.test(brand)
  ) {
    throw new HttpError("permanent", `apploi brand rejected: ${JSON.stringify(brand)}`);
  }
}

// Job ids are numeric strings ("1479234"); they flow into the public
// job-card URL, so anything non-numeric is rejected rather than escaped.
function apploiSourceId(raw: string | number | null | undefined): string | undefined {
  const s = typeof raw === "number" && Number.isFinite(raw) ? String(raw) : raw;
  return typeof s === "string" && /^[0-9]{1,16}$/.test(s) ? s : undefined;
}

// Salary fields are hourly or annual numbers with 0 standing in for "not
// published". JobSchema stores compensation as integers — rounding keeps
// the signal (sortable, comparable) without inventing precision. An
// inverted pair (min above max) is vendor noise; drop both rather than
// letting the schema reject the whole row.
function apploiCompensation(
  min: number | null | undefined,
  max: number | null | undefined,
): { min?: number; max?: number } {
  const norm = (v: number | null | undefined): number | undefined =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : undefined;
  const cMin = norm(min);
  const cMax = norm(max);
  if (cMin !== undefined && cMax !== undefined && cMin > cMax) return {};
  return {
    ...(cMin !== undefined ? { min: cMin } : {}),
    ...(cMax !== undefined ? { max: cMax } : {}),
  };
}

function trimmedOrUndefined(raw: string | null | undefined): string | undefined {
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : undefined;
}

// Rows from the search response whose `brand_name` equals the tenant brand
// exactly — the fuzzy-tail rows from other brands never reach the builder.
export function apploiBrandRows(response: unknown, brand: string): ApploiRow[] {
  const body = response as ApploiResponse | null | undefined;
  const data = Array.isArray(body?.data) ? body.data : [];
  return data.filter(
    (r): r is ApploiRow => r !== null && typeof r === "object" && r.brand_name === brand,
  );
}

export interface ParseApploiJobsInput {
  readonly tenant: TenantInput;
  readonly company: string;
  readonly brand: string;
  readonly response: unknown;
  readonly observedAt: string;
}

// Pure parser over one search page: exact-brand rows → validated Jobs,
// deduped by id. Decoupled from HTTP so it can be fixture-replayed and
// property-tested deterministically.
export function parseApploiJobs(input: ParseApploiJobsInput): Job[] {
  const jobs: Job[] = [];
  for (const r of apploiBrandRows(input.response, input.brand)) {
    const sourceId = apploiSourceId(r.id);
    const title = trimmedOrUndefined(r.name);
    if (sourceId === undefined || title === undefined) continue;
    // Canonical public job card; verified live to render the specific
    // posting (HTTP 200).
    const url = `https://jobs.apploi.com/view/${sourceId}`;
    const location = [trimmedOrUndefined(r.city), trimmedOrUndefined(r.state)]
      .filter((s): s is string => s !== undefined)
      .join(", ");
    // published_date is date-only ("2026-07-02") → normalises to
    // 00:00:00Z; drop any value that would violate the schema's
    // posted_at <= last_seen_at rule rather than failing the row.
    const postedRaw = vendorDateToIsoZ(r.published_date);
    const postedAt =
      postedRaw !== undefined && postedRaw <= input.observedAt ? postedRaw : undefined;
    const comp = apploiCompensation(r.salary_min, r.salary_max);
    // Titles occasionally arrive entity-encoded ("Chef &amp; Dietary
    // Manager"); decode once so the stored title is what a visitor sees.
    const decodedTitle = decodeHtmlEntities(title);

    const candidate = buildJob({
      ats: "apploi",
      tenant_slug: input.tenant.slug,
      // The row's own brand_name is the company (it equals the tenant
      // brand after filtering); the seeded display fallback covers the
      // pathological empty case only.
      company: trimmedOrUndefined(r.brand_name) ?? input.company,
      source_id: sourceId,
      title: decodedTitle,
      url,
      ...(r.description ? { description_html: r.description } : {}),
      ...(location.length > 0 ? { location_text: location } : {}),
      workplace_hint: `${decodedTitle} ${location}`,
      ...(postedAt !== undefined ? { posted_at: postedAt } : {}),
      ...(comp.min !== undefined ? { compensation_min: comp.min } : {}),
      ...(comp.max !== undefined ? { compensation_max: comp.max } : {}),
      is_recruiter_post: isRecruiterTitle(decodedTitle),
      first_seen_at: input.observedAt,
      last_seen_at: input.observedAt,
    });
    const validated = JobSchema.safeParse(candidate);
    if (validated.success) jobs.push(validated.data);
  }
  return dedupeById(jobs);
}

export interface ScrapeApploiOptions {
  readonly tenant: TenantInput;
  readonly client: HttpClient;
  readonly observedAt: string;
  // Verbatim brand name string the search API filters on. Mandatory and
  // not slug-derivable, so the dispatcher marks tenants without it dead.
  readonly brand: string;
}

export interface ScrapeApploiOutcome {
  readonly jobs: ReadonlyArray<Job>;
  readonly result: TenantResult;
}

export async function scrapeApploiTenant(opts: ScrapeApploiOptions): Promise<ScrapeApploiOutcome> {
  try {
    assertSafeSlug(opts.tenant.slug);
    assertApploiBrand(opts.brand);
    const company = opts.tenant.display_name ?? opts.tenant.slug;
    const jobs: Job[] = [];
    let httpStatus = 0;

    // Pages are 1-based. Three exhaustion signals, any of which stops the
    // walk: a page with zero exact-brand rows (unknown brand, or the fuzzy
    // tail has fully taken over), a mixed page (exact rows followed by
    // foreign ones — exact matches outscore fuzzy ones, so nothing exact
    // remains beyond it), or a short page.
    for (let page = 1; page <= MAX_PAGES; page++) {
      const url = `${SEARCH_URL}?page=${page}&size=${PAGE_SIZE}&brand=${encodeURIComponent(opts.brand)}`;
      const res = await opts.client.request(url);
      httpStatus = res.status;
      const body = (await res.json()) as ApploiResponse;
      const rowCount = Array.isArray(body?.data) ? body.data.length : 0;
      const brandRowCount = apploiBrandRows(body, opts.brand).length;
      if (brandRowCount === 0) break;
      for (const job of parseApploiJobs({
        tenant: opts.tenant,
        company,
        brand: opts.brand,
        response: body,
        observedAt: opts.observedAt,
      })) {
        jobs.push(job);
      }
      if (brandRowCount < rowCount || rowCount < PAGE_SIZE) break;
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
