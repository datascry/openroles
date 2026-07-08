import { type Job, JobSchema, type TenantInput, type TenantResult } from "@openroles/shared";
import { buildJob } from "../build-job.ts";
import type { HttpClient } from "../http.ts";
import { plainText } from "../normalize.ts";
import {
  assertSafeSlug,
  dedupeById,
  errorToResult,
  isRecruiterTitle,
  vendorDateToIsoZ,
} from "./common.ts";

// JobScore hosted careers boards. Every tenant is a path slug on the shared
// host `careers.jobscore.com`; the public unauthenticated JSON feed at
// `careers.jobscore.com/jobs/{slug}/feed.json` returns the ENTIRE open-role
// list in one call — `{ company_name, company_code (== slug), jobs: [...] }`.
// Each entry already carries the full HTML `description`, the `opened_date`
// and `last_updated_date` timestamps, `location` / `department`, an integer
// `job_status_id`, and a canonical `detail_url` on the shared host, so one GET
// per tenant covers everything: the feed returns every role regardless of a
// `?page=N` parameter (verified against a 65-role board — no per-page cap), so
// there is no pagination and no per-job detail fetch. robots.txt disallows only
// `/apply_flow/`, so the feed path is crawl-permitted. Tenant identity = slug
// (path segment); no metadata is required.

const FEED_HOST = "careers.jobscore.com";

// The feed publishes an integer `job_status_id`. In practice it only ever
// returns open roles — 81 (published/open) is the sole value observed across
// every live board — but we still drop explicitly-closed rows defensively.
// The stance is default-OPEN with a deny-list of known-closed ids (82 = filled/
// closed) rather than an allow-list of one, so a future new *open* status id
// isn't silently zeroed out of the corpus (matching the hireology posture).
const CLOSED_STATUS_IDS = new Set<number>([82]);

// One posting as returned in the feed's `jobs[]`. Only the fields the adapter
// consumes are typed; the payload carries more (structured city/state/country,
// salary, custom fields) that the listing text already covers.
interface JobscoreJob {
  id?: string | null;
  title?: string | null;
  job_status_id?: number | null;
  company_name?: string | null;
  department?: string | null;
  location?: string | null;
  description?: string | null;
  opened_date?: string | null;
  last_updated_date?: string | null;
  detail_url?: string | null;
  url_slug?: string | null;
}

interface JobscoreFeed {
  company_name?: string | null;
  company_code?: string | null;
  jobs?: ReadonlyArray<JobscoreJob>;
}

function trimmedOrUndefined(raw: string | null | undefined): string | undefined {
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : undefined;
}

// Canonical public job URL. Prefer the row's own `detail_url` when it is a
// well-formed https link on the shared feed host with no embedded credentials;
// anything else (scheme downgrade, off-host, userinfo) falls back to the
// composed career-site deep link. The composed URL uses `url_slug` when the row
// carries it (`{title-slug}-{id}`, the exact path JobScore renders) and the
// bare id otherwise — either resolves to the same posting. Anchoring to the
// canonical host keeps a payload-supplied URL from pointing the corpus at an
// arbitrary origin.
function jobUrlFor(
  slug: string,
  sourceId: string,
  urlSlug: string | undefined,
  rawUrl: string | null | undefined,
): string {
  if (typeof rawUrl === "string") {
    try {
      const parsed = new URL(rawUrl);
      if (
        parsed.protocol === "https:" &&
        parsed.hostname === FEED_HOST &&
        parsed.username === "" &&
        parsed.password === ""
      ) {
        return parsed.toString();
      }
    } catch {
      // fall through to the composed deep link
    }
  }
  const tail = urlSlug ?? sourceId;
  return `https://${FEED_HOST}/careers/${slug}/jobs/${encodeURIComponent(tail)}`;
}

// opened_date / last_updated_date are millisecond-precision UTC timestamps
// (`2026-05-27T16:22:10.459Z`). Normalise and drop any value that would
// violate the schema's `<= last_seen_at` rule (clock skew, scheduled
// postings) rather than letting safeParse reject the whole row.
function boundedDate(raw: string | null | undefined, observedAt: string): string | undefined {
  const iso = vendorDateToIsoZ(raw);
  return iso !== undefined && iso <= observedAt ? iso : undefined;
}

function feedJobToJob(
  tenantSlug: string,
  fallbackCompany: string,
  observedAt: string,
  j: JobscoreJob,
): Job | null {
  const sourceId = trimmedOrUndefined(j.id);
  if (sourceId === undefined) return null;
  // Titles occasionally carry HTML entities; plainText decodes and collapses.
  const title = trimmedOrUndefined(plainText(j.title ?? ""));
  if (title === undefined) return null;
  // Drop explicitly-closed rows; default to emitting so an unseen open-status
  // id survives (see CLOSED_STATUS_IDS above).
  if (typeof j.job_status_id === "number" && CLOSED_STATUS_IDS.has(j.job_status_id)) return null;

  const urlSlug = trimmedOrUndefined(j.url_slug);
  const url = jobUrlFor(tenantSlug, sourceId, urlSlug, j.detail_url);
  const company = trimmedOrUndefined(j.company_name) ?? fallbackCompany;
  const locationText = trimmedOrUndefined(j.location);
  const department = trimmedOrUndefined(j.department);
  const postedAt = boundedDate(j.opened_date, observedAt);
  const updatedAt = boundedDate(j.last_updated_date, observedAt);
  const descriptionHtml = trimmedOrUndefined(j.description);

  const candidate = buildJob({
    ats: "jobscore",
    tenant_slug: tenantSlug,
    company,
    source_id: sourceId,
    title,
    url,
    ...(descriptionHtml !== undefined ? { description_html: descriptionHtml } : {}),
    ...(locationText !== undefined ? { location_text: locationText } : {}),
    workplace_hint: `${title} ${locationText ?? ""}`,
    ...(department !== undefined ? { department } : {}),
    ...(postedAt !== undefined ? { posted_at: postedAt } : {}),
    ...(updatedAt !== undefined ? { updated_at: updatedAt } : {}),
    is_recruiter_post: isRecruiterTitle(title),
    first_seen_at: observedAt,
    last_seen_at: observedAt,
  });
  const validated = JobSchema.safeParse(candidate);
  return validated.success ? validated.data : null;
}

export interface ParseJobscoreFeedInput {
  readonly tenant: TenantInput;
  readonly company: string;
  readonly response: unknown;
  readonly observedAt: string;
}

// Pure parser over one feed.json response: `jobs[]` → validated Jobs, filtered
// to open roles and deduped by id. Decoupled from HTTP so it can be
// fixture-replayed and property-tested deterministically.
export function parseJobscoreFeed(input: ParseJobscoreFeedInput): Job[] {
  const body = input.response as JobscoreFeed;
  const list = Array.isArray(body.jobs) ? body.jobs : [];
  // The feed's own `company_name` is the authoritative brand; fall back to the
  // caller-supplied company (display name / slug) when the feed omits it.
  const company = trimmedOrUndefined(body.company_name) ?? input.company;
  const jobs: Job[] = [];
  for (const j of list) {
    const job = feedJobToJob(input.tenant.slug, company, input.observedAt, j);
    if (job) jobs.push(job);
  }
  return dedupeById(jobs);
}

export interface ScrapeJobscoreOptions {
  readonly tenant: TenantInput;
  readonly client: HttpClient;
  readonly observedAt: string;
}

export interface ScrapeJobscoreOutcome {
  readonly jobs: ReadonlyArray<Job>;
  readonly result: TenantResult;
}

export async function scrapeJobscoreTenant(
  opts: ScrapeJobscoreOptions,
): Promise<ScrapeJobscoreOutcome> {
  try {
    assertSafeSlug(opts.tenant.slug);
    const url = `https://${FEED_HOST}/jobs/${opts.tenant.slug}/feed.json`;
    const res = await opts.client.request(url);
    const body = (await res.json()) as unknown;
    const company = opts.tenant.display_name ?? opts.tenant.slug;
    const jobs = parseJobscoreFeed({
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
        http_status: res.status,
        jobs_count: jobs.length,
      },
    };
  } catch (err) {
    return { jobs: [], result: errorToResult(opts.tenant.slug, err) };
  }
}
