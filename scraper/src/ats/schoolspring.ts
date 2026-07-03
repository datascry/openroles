import { type Job, JobSchema, type TenantInput, type TenantResult } from "@openroles/shared";
import { z } from "zod";
import { buildJob } from "../build-job.ts";
import type { HttpClient } from "../http.ts";
import { decodeHtmlEntities, plainText } from "../normalize.ts";
import { dedupeById, errorToResult, isRecruiterTitle } from "./common.ts";

// SchoolSpring public jobs API. One shared national board for K-12
// education roles — districts, individual schools and education service
// agencies all post to it, so this is a single-TENANT adapter over a
// multi-EMPLOYER corpus: `employer` on each list row becomes Job.company.
//
// Endpoints (GET, JSON, unauthenticated):
//   /api/Jobs/GetJobsCountWithSearch?{search}   → { success, value: <int> }
//   /api/Jobs/GetPagedJobsWithSearch?page={N}&size={M}&{search}
//     → { success, message, validationErrors, value: { page, size, jobsList } }
//   jobsList rows: { jobId, employer, title, location, displayDate }
//
// Both endpoints wrap everything in the same `{ success, message,
// validationErrors, value }` envelope; a rejected query answers HTTP 200
// with `success: false`, so the envelope flag — not the status code — is
// the error signal. `page` is 1-based (page=0 is a 400). Past the last
// page the API answers 200 with an empty jobsList, so the loop
// terminates on BOTH count-reached and empty/short page.
//
// The corpus is ~100k live roles and there is a per-job detail endpoint,
// but fetching it would be a 100k-request fan-out per run. The list row
// already carries everything the slim index needs, so the adapter builds
// jobs from the list payload alone. The API serves 20,000-row pages
// reliably (verified live at 1-2s per page), which keeps a full sweep at
// about six list requests.
//
// `displayDate` is a zone-less local timestamp ("2026-07-03T13:08:11").
// It's read as UTC and clamped to the observation instant so a
// vendor-side clock skew can never emit a future posted_at.

const API_BASE = "https://api.schoolspring.com/api/Jobs";
// The API requires the full search-parameter set even when empty; an
// omitted parameter is treated as a validation error, not a wildcard.
const SEARCH_PARAMS = "keyword=&location=&category=&gradelevel=&jobtype=&organization=";
// 20k rows/page is a deliberate memory-for-request-count trade: each page
// body is ~6 MB parsed transiently (never shipped), and it covers the
// ~100k-row corpus in ~6 requests instead of ~1,000 at a timid size.
const PAGE_SIZE = 20_000;
// 160k-row ceiling against a ~101k corpus — generous headroom before the
// cap truncates a run.
const DEFAULT_MAX_PAGES = 8;
const TENANT_SLUG = "schoolspring";
const FALLBACK_COMPANY = "SchoolSpring";

const SchoolSpringRow = z
  .object({
    jobId: z.union([z.string(), z.number()]).nullish(),
    employer: z.string().nullish(),
    title: z.string().nullish(),
    location: z.string().nullish(),
    displayDate: z.string().nullish(),
  })
  .passthrough();

// Rows stay unknown[] here so one malformed row is skipped by the
// per-row safeParse instead of failing the whole page.
const SchoolSpringEnvelope = z
  .object({
    success: z.boolean(),
    message: z.string().nullish(),
    validationErrors: z.array(z.unknown()).nullish(),
    value: z
      .object({
        page: z.number().nullish(),
        size: z.number().nullish(),
        jobsList: z.array(z.unknown()).nullish(),
      })
      .nullish(),
  })
  .passthrough();

const SchoolSpringCountEnvelope = z
  .object({
    success: z.boolean(),
    message: z.string().nullish(),
    validationErrors: z.array(z.unknown()).nullish(),
    value: z.number().nullish(),
  })
  .passthrough();

function assertEnvelopeSuccess(env: {
  success: boolean;
  message?: string | null | undefined;
  validationErrors?: ReadonlyArray<unknown> | null | undefined;
}): void {
  if (env.success) return;
  const details = [env.message, ...(env.validationErrors ?? []).map(String)]
    .filter((s): s is string => typeof s === "string" && s.length > 0)
    .join("; ");
  throw new Error(`schoolspring API answered success=false${details ? `: ${details}` : ""}`);
}

// A zone designator is anything Date.parse would honor: trailing Z or a
// ±hh[:]mm offset. SchoolSpring's timestamps carry neither, so they are
// pinned to UTC explicitly — an unsuffixed string parses in the runner's
// local zone, which would make posted_at depend on where the scrape ran.
const HAS_ZONE = /(?:Z|[+-]\d{2}:?\d{2})$/i;

function postedAtIso(value: string | null | undefined, observedAt: string): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  const trimmed = value.trim();
  const pinned = HAS_ZONE.test(trimmed) ? trimmed : `${trimmed}Z`;
  const posted = new Date(pinned).getTime();
  if (Number.isNaN(posted)) return undefined;
  const observed = new Date(observedAt).getTime();
  // Clamp instead of drop: a same-day post with vendor clock skew is
  // still a real signal, it just can't postdate the observation.
  return new Date(Math.min(posted, observed)).toISOString();
}

export interface ParseSchoolSpringInput {
  readonly tenant: TenantInput;
  readonly response: unknown;
  readonly observedAt: string;
}

/**
 * Parse one page of the SchoolSpring list API into normalized Jobs.
 * Pure; deterministic; safe to fixture-replay and property-test. Throws
 * on a success:false envelope (the vendor's error channel); skips
 * individual rows that are malformed or missing a usable (jobId, title).
 */
export function parseSchoolSpring(input: ParseSchoolSpringInput): Job[] {
  const env = SchoolSpringEnvelope.parse(input.response);
  assertEnvelopeSuccess(env);
  const jobs: Job[] = [];
  for (const rawRow of env.value?.jobsList ?? []) {
    const parsedRow = SchoolSpringRow.safeParse(rawRow);
    if (!parsedRow.success) continue;
    const row = parsedRow.data;
    if (row.jobId === undefined || row.jobId === null) continue;
    const sourceId = String(row.jobId);
    // Decode entities BEFORE plainText so `R&amp;D` survives as `R&D`
    // (plainText joins its text nodes with spaces otherwise).
    const title = row.title ? plainText(decodeHtmlEntities(row.title)) : "";
    if (title.length === 0) continue;
    const employer = row.employer ? plainText(decodeHtmlEntities(row.employer)) : "";
    const company =
      employer.length > 0 ? employer : (input.tenant.display_name ?? FALLBACK_COMPANY);
    const location = row.location?.trim() ?? "";
    const postedAt = postedAtIso(row.displayDate, input.observedAt);
    const candidate = buildJob({
      ats: "schoolspring",
      tenant_slug: input.tenant.slug,
      company,
      source_id: sourceId,
      title,
      url: `https://www.schoolspring.com/jobdetail?jobId=${encodeURIComponent(sourceId)}`,
      ...(location.length > 0 ? { location_text: location } : {}),
      // No structured workplace field — infer from title + location
      // text as a best-effort hint.
      workplace_hint: `${title} ${location}`,
      is_recruiter_post: isRecruiterTitle(title),
      ...(postedAt !== undefined ? { posted_at: postedAt } : {}),
      first_seen_at: input.observedAt,
      last_seen_at: input.observedAt,
    });
    const validated = JobSchema.safeParse(candidate);
    if (validated.success) jobs.push(validated.data);
  }
  return dedupeById(jobs);
}

export interface ScrapeSchoolSpringOptions {
  readonly tenant: TenantInput;
  readonly client: HttpClient;
  readonly observedAt: string;
  readonly pageSize?: number;
  readonly maxPages?: number;
}

export interface ScrapeSchoolSpringOutcome {
  readonly jobs: ReadonlyArray<Job>;
  readonly result: TenantResult;
}

export async function scrapeSchoolSpringTenant(
  opts: ScrapeSchoolSpringOptions,
): Promise<ScrapeSchoolSpringOutcome> {
  // The single tenant is hard-coded to `schoolspring`; anything else is
  // a caller mistake. Reject early so the dispatcher's contract stays
  // explicit.
  if (opts.tenant.slug !== TENANT_SLUG) {
    return {
      jobs: [],
      result: {
        slug: opts.tenant.slug,
        status: "dead",
        error: `schoolspring is a single-tenant ATS, slug must be "${TENANT_SLUG}"`,
        jobs_count: 0,
      },
    };
  }
  const size = opts.pageSize ?? PAGE_SIZE;
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES;
  const collected: Job[] = [];
  let lastStatus = 0;
  try {
    // The count is the cheap authoritative total; combined with the
    // empty-page check below it gives two independent loop terminators.
    const countRes = await opts.client.request(
      `${API_BASE}/GetJobsCountWithSearch?${SEARCH_PARAMS}`,
      { method: "GET" },
    );
    lastStatus = countRes.status;
    const countEnv = SchoolSpringCountEnvelope.parse(await countRes.json());
    assertEnvelopeSuccess(countEnv);
    const total = typeof countEnv.value === "number" ? countEnv.value : Number.POSITIVE_INFINITY;
    let fetched = 0;
    for (let page = 1; page <= maxPages; page++) {
      if (fetched >= total) break;
      const url = `${API_BASE}/GetPagedJobsWithSearch?page=${page}&size=${size}&${SEARCH_PARAMS}`;
      const res = await opts.client.request(url, { method: "GET" });
      lastStatus = res.status;
      const body = await res.json();
      const pageJobs = parseSchoolSpring({
        tenant: opts.tenant,
        response: body,
        observedAt: opts.observedAt,
      });
      for (const j of pageJobs) collected.push(j);
      // Raw row count (not parsed-job count) drives termination so a
      // page of skipped rows can't loop forever.
      const got = SchoolSpringEnvelope.parse(body).value?.jobsList?.length ?? 0;
      fetched += got;
      if (got < size) break;
    }
    const jobs = dedupeById(collected);
    return {
      jobs,
      result: {
        slug: opts.tenant.slug,
        status: "success",
        http_status: lastStatus || 200,
        jobs_count: jobs.length,
      },
    };
  } catch (err) {
    return { jobs: [], result: errorToResult(opts.tenant.slug, err) };
  }
}
