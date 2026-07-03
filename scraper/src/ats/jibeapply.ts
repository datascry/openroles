import { type Job, JobSchema, type TenantInput, type TenantResult } from "@openroles/shared";
import { buildJob } from "../build-job.ts";
import { type HttpClient, HttpError } from "../http.ts";
import { decodeHtmlEntities } from "../normalize.ts";
import {
  assertSafeSlug,
  dedupeById,
  errorToResult,
  isRecruiterTitle,
  isSafeFetchHost,
  vendorDateToIsoZ,
} from "./common.ts";

// Jibe hosted career sites. Every customer gets a public board whose
// `/api/jobs` endpoint returns unauthenticated JSON: a `jobs[]` array (one
// `{ data: {...} }` wrapper per posting) plus a `totalCount`. Each `data`
// object carries the full HTML description, so a single listing walk covers
// title, location, salary band, department and excerpt — no per-job detail
// fetch is needed.
//
// Tenant identity = slug: the board host defaults to `{slug}.jibeapply.com`.
// A few customers serve the identical API from a vanity CNAME
// (careers.{brand}.com); those are operator-seeded via `metadata.host` and
// SSRF-guarded here rather than anchored to a fixed suffix — the same
// posture as the phenom adapter's vanity domains.
//
// The canonical public job URL is `https://{host}/jobs/{req_id}` (HTTP 200,
// no auth). The payload's `apply_url` deep-links into the backing ATS's
// login flow, so it is deliberately NOT used as the Job url.

const PAGE_SIZE = 100;
// 6,000-posting ceiling per tenant. The largest observed boards carry a
// couple thousand roles; this bounds the per-tenant fan-out so a single
// mega-tenant cannot blow the matrix runner's time budget while still
// covering every real-world site in full.
const MAX_PAGES = 60;

// Dotted public hostname only (no scheme, userinfo, port or path); combined
// with isSafeFetchHost this bounds an operator-seeded vanity host to a real
// careers domain and closes the SSRF surface on that seed channel.
const JIBEAPPLY_HOST_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?\.)+[a-z]{2,}$/i;

function assertJibeapplyHost(host: string): void {
  let parsed: URL;
  try {
    parsed = new URL(`https://${host}`);
  } catch {
    throw new HttpError("permanent", `jibeapply host rejected: ${JSON.stringify(host)}`);
  }
  if (
    !JIBEAPPLY_HOST_RE.test(host) ||
    parsed.hostname !== host.toLowerCase() ||
    !isSafeFetchHost(parsed)
  ) {
    throw new HttpError("permanent", `jibeapply host rejected: ${JSON.stringify(host)}`);
  }
}

interface JibeapplyJobData {
  req_id?: string | null;
  title?: string | null;
  description?: string | null;
  city?: string | null;
  state?: string | null;
  full_location?: string | null;
  categories?: ReadonlyArray<{ name?: string | null }> | null;
  department?: string | null;
  salary_min_value?: number | null;
  salary_max_value?: number | null;
  posted_date?: string | null;
  update_date?: string | null;
}

interface JibeapplyResponse {
  jobs?: ReadonlyArray<{ data?: JibeapplyJobData }>;
  totalCount?: number;
}

function trimmedOrUndefined(raw: string | null | undefined): string | undefined {
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : undefined;
}

// Salary bounds arrive as numbers with a `0` sentinel for "not disclosed"
// and occasionally fractional cents; the schema wants non-negative integers,
// so zero/absent values are dropped and real values rounded. A band whose
// min exceeds its max is a tenant data glitch — drop both rather than let
// safeParse reject the whole row.
function salaryToInt(raw: number | null | undefined): number | undefined {
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? Math.round(raw) : undefined;
}

// posted_date/update_date are full ISO timestamps with a +0000 offset. Drop
// any value that would post-date the scrape rather than violating the
// schema's posted_at/updated_at <= last_seen_at rule.
function clampedDate(raw: string | null | undefined, observedAt: string): string | undefined {
  const iso = vendorDateToIsoZ(raw);
  return iso && iso <= observedAt ? iso : undefined;
}

function dataToJob(
  tenantSlug: string,
  company: string,
  host: string,
  observedAt: string,
  d: JibeapplyJobData,
): Job | null {
  const sourceId = trimmedOrUndefined(d.req_id);
  const rawTitle = trimmedOrUndefined(d.title);
  if (!sourceId || !rawTitle) return null;
  const title = decodeHtmlEntities(rawTitle);
  // Canonical public job card. `/jobs/{req_id}` renders the specific posting
  // (HTTP 200) on both default and vanity hosts; the payload's `apply_url`
  // points into the backing ATS's login flow and is not a public page.
  const url = `https://${host}/jobs/${sourceId}`;

  // `full_location` is the display string the board itself shows; when a
  // tenant leaves it blank, fall back to joining the structured city/state.
  const location =
    trimmedOrUndefined(d.full_location) ??
    [trimmedOrUndefined(d.city), trimmedOrUndefined(d.state)]
      .filter((s): s is string => s !== undefined)
      .join(", ");
  // `department` is often empty; the first `categories[]` name is the
  // board's own grouping and makes a faithful fallback.
  const department =
    trimmedOrUndefined(d.department) ?? trimmedOrUndefined(d.categories?.[0]?.name);

  let compensationMin = salaryToInt(d.salary_min_value);
  let compensationMax = salaryToInt(d.salary_max_value);
  if (compensationMin !== undefined && compensationMax !== undefined) {
    if (compensationMin > compensationMax) {
      compensationMin = undefined;
      compensationMax = undefined;
    }
  }

  const postedAt = clampedDate(d.posted_date, observedAt);
  const updatedAt = clampedDate(d.update_date, observedAt);

  const candidate = buildJob({
    ats: "jibeapply",
    tenant_slug: tenantSlug,
    company,
    source_id: sourceId,
    title,
    url,
    // The description is full vendor HTML — run it through the shared
    // plainText/excerpt path so tags and entities are stripped and the
    // excerpt is control-char-safe.
    ...(d.description ? { description_html: d.description } : {}),
    ...(location.length > 0 ? { location_text: location } : {}),
    // No structured workplace field is exposed, so workplace_type is
    // inferred from the title/location text — a best-effort hint.
    workplace_hint: `${title} ${location}`,
    ...(department ? { department } : {}),
    ...(compensationMin !== undefined ? { compensation_min: compensationMin } : {}),
    ...(compensationMax !== undefined ? { compensation_max: compensationMax } : {}),
    ...(postedAt ? { posted_at: postedAt } : {}),
    ...(updatedAt ? { updated_at: updatedAt } : {}),
    is_recruiter_post: isRecruiterTitle(title),
    first_seen_at: observedAt,
    last_seen_at: observedAt,
  });
  const validated = JobSchema.safeParse(candidate);
  return validated.success ? validated.data : null;
}

export interface ParseJibeapplyInput {
  readonly tenant: TenantInput;
  readonly company: string;
  readonly host: string;
  readonly response: unknown;
  readonly observedAt: string;
}

// Pure parser over one /api/jobs page: `jobs[].data` → validated Jobs,
// deduped by id. Decoupled from HTTP so it can be fixture-replayed and
// property-tested deterministically.
export function parseJibeapplyJobs(input: ParseJibeapplyInput): Job[] {
  const body = input.response as JibeapplyResponse;
  const list = body.jobs ?? [];
  const jobs: Job[] = [];
  for (const entry of list) {
    if (!entry.data) continue;
    const job = dataToJob(
      input.tenant.slug,
      input.company,
      input.host,
      input.observedAt,
      entry.data,
    );
    if (job) jobs.push(job);
  }
  return dedupeById(jobs);
}

export interface ScrapeJibeapplyOptions {
  readonly tenant: TenantInput;
  readonly client: HttpClient;
  readonly observedAt: string;
  // Optional vanity CNAME host for tenants whose board is served from a
  // branded domain; defaults to `{slug}.jibeapply.com` when absent.
  readonly host?: string;
}

export interface ScrapeJibeapplyOutcome {
  readonly jobs: ReadonlyArray<Job>;
  readonly result: TenantResult;
}

export async function scrapeJibeapplyTenant(
  opts: ScrapeJibeapplyOptions,
): Promise<ScrapeJibeapplyOutcome> {
  try {
    assertSafeSlug(opts.tenant.slug);
    const host = opts.host ?? `${opts.tenant.slug}.jibeapply.com`;
    assertJibeapplyHost(host);
    const company = opts.tenant.display_name ?? opts.tenant.slug;
    const jobs: Job[] = [];
    let httpStatus = 0;
    let total = Number.POSITIVE_INFINITY;

    // `page` is 1-based; `limit` (NOT pageSize) raises the default 10 rows
    // per page to 100. Walk until totalCount is covered or a short page ends
    // the board early.
    for (let page = 1; page <= MAX_PAGES; page++) {
      if ((page - 1) * PAGE_SIZE >= total) break;
      const url = `https://${host}/api/jobs?page=${page}&limit=${PAGE_SIZE}`;
      const res = await opts.client.request(url);
      httpStatus = res.status;
      const body = (await res.json()) as JibeapplyResponse;
      if (typeof body.totalCount === "number") total = body.totalCount;
      const pageCount = body.jobs?.length ?? 0;
      for (const job of parseJibeapplyJobs({
        tenant: opts.tenant,
        company,
        host,
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
