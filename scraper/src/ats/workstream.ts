import { type Job, JobSchema, type TenantInput, type TenantResult } from "@openroles/shared";
import { decodeHTML } from "entities";
import pLimit from "p-limit";
import { buildJob } from "../build-job.ts";
import { type HttpClient, HttpError } from "../http.ts";
import { assertSafeSlug, dedupeById, errorToResult, isRecruiterTitle } from "./common.ts";
import {
  extractJobPostingJsonLd,
  jsonLdLocationText,
  normalizeJobPostingDate,
} from "./jsonld-core.ts";

// Workstream hourly-hiring boards. Every tenant's public board lives on the
// single shared host `www.workstream.us` at `/j/{companyId}/{slug}/positions`,
// which server-renders 10 role links per page as
// `<a class="view-position-btn" href=".../j/{companyId}/{slug}/{location}/{role}-{jobId}">`;
// `?page=N` advances the window, and a page past the end still answers
// HTTP 200 with the board chrome but zero position links. Each job page
// carries one complete `schema.org/JobPosting` JSON-LD block (emitted for
// Google for Jobs), so per-job detail is read through the shared jsonld-core
// extractor rather than by scraping the rendered HTML.
//
// Tenant identity is the composite (company_id, slug): the board URL embeds
// an 8-hex company id alongside the human-readable slug, and neither is
// derivable from the other, so `metadata.company_id` is mandatory (the
// dispatcher marks tenants without it dead, like workday's host). A dead or
// unknown pair answers HTTP 410 Gone.

const BOARD_HOST = "www.workstream.us";

// Board pagination + per-tenant detail fan-out bounds. Workstream customers
// are hourly-hiring SMB/franchise operators (tens of roles per board is
// typical); 40 pages × 10 roles/page = 400 detail fetches sits comfortably
// above the largest verified seed, so both caps are backstops against a
// pathological board rather than routine truncation. When the cap does bite,
// the truncation is surfaced in TenantResult.error rather than reported as a
// clean success.
const MAX_BOARD_PAGES = 40;
const MAX_DETAIL_FETCH_PER_TENANT = 400;

// Request pacing + degraded-response recovery. www.workstream.us applies a
// per-IP soft rate limit: past a burst threshold it keeps answering HTTP 200
// but serves the job page *without* its JSON-LD block (the rest of the page
// is intact), and the throttle lifts within ~10-15s of easing off. Verified
// live 2026-07-03: an unpaced concurrency-4 fan-out lost the JSON-LD on 75%
// of pages, while 1 request/second sustained 0 losses. So every request to
// the host flows through a pacer that serializes them and enforces a ~1s
// gap, and a page that comes back without a JobPosting is re-fetched
// (bounded attempts, bounded tenant-wide budget) after a recovery pause
// before being counted as a failure.
//
// Worst case per tenant is therefore provably bounded:
//   ≤ 40 board pages + ≤ 400 detail pages + ≤ 20 budgeted re-fetches
//   = ≤ 460 paced requests ≈ 460s, plus ≤ 20 × 15s = 300s of degraded
//   backoff ≈ ≤ 13 minutes.
const DEFAULT_REQUEST_DELAY_MS = 1_000;
const DEFAULT_DEGRADED_RETRY_DELAY_MS = 15_000;
// Per-role and per-tenant ceilings on degraded re-fetches. The per-role
// ceiling handles a role that stays degraded across recoveries; the
// tenant-wide budget stops a systemically degraded run (e.g. the vendor
// dropping JSON-LD entirely) from stalling the runner 30s per role — once
// spent, remaining failures are counted immediately and the shortfall is
// surfaced in TenantResult.error.
const DEGRADED_REFETCH_ATTEMPTS = 2;
const MAX_DEGRADED_REFETCHES_PER_TENANT = 20;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Serializes requests and enforces a minimum gap between them. The rate
// limit is per-IP across the whole shared host, not per tenant, so pacing
// inside a single scrapeWorkstreamTenant call is not enough: the scrape
// orchestrator runs tenants concurrently, and N tenants pacing
// independently at 1 req/s would still hit the host at N req/s — the exact
// regime that strips the JSON-LD.
export interface WorkstreamPacer {
  schedule<T>(work: () => Promise<T>): Promise<T>;
}

export interface WorkstreamPacerOptions {
  readonly requestDelayMs?: number;
  readonly sleepFn?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

export function createWorkstreamPacer(opts: WorkstreamPacerOptions = {}): WorkstreamPacer {
  const gate = pLimit(1);
  const sleep = opts.sleepFn ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const delayMs = opts.requestDelayMs ?? DEFAULT_REQUEST_DELAY_MS;
  // Earliest instant the next request may start; advanced after every
  // request (success or failure) so errors are spaced like successes.
  let earliestNext = 0;
  return {
    schedule: (work) =>
      gate(async () => {
        const wait = earliestNext - now();
        if (wait > 0) await sleep(wait);
        try {
          return await work();
        } finally {
          earliestNext = now() + delayMs;
        }
      }),
  };
}

// Module-scope shared pacer: one per process, spanning every
// scrapeWorkstreamTenant invocation. Process scope equals host scope here
// because the scrape workflow's matrix runs each ATS in its own runner
// process — all traffic this process ever sends to www.workstream.us goes
// through this single gate, so the aggregate host rate stays at ~1 req/s
// no matter how many tenants the orchestrator runs concurrently.
const SHARED_PACER: WorkstreamPacer = createWorkstreamPacer();

// The 8-hex company id that routes the shared host to a tenant. It flows
// into request URLs, so anything else is rejected before a request is made.
const WORKSTREAM_COMPANY_ID = /^[0-9a-f]{8}$/;

function assertWorkstreamCompanyId(companyId: string): void {
  if (!WORKSTREAM_COMPANY_ID.test(companyId)) {
    throw new HttpError(
      "permanent",
      `workstream company id rejected: ${JSON.stringify(companyId)}`,
    );
  }
}

function escapeForRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface WorkstreamListingEntry {
  readonly sourceId: string;
  readonly url: string;
}

// Extract the (jobId, canonical URL) of every position linked from one board
// page. Matching is anchored to the tenant's own `/j/{companyId}/{slug}/`
// prefix so location pages, board chrome, and cross-tenant links can never be
// mistaken for a job; a position link is the only shape with two further path
// segments where the last ends in the 8-hex job id. Deduped by jobId — the
// board can repeat a link across card layouts.
export function parseWorkstreamBoardPage(
  html: string,
  companyId: string,
  slug: string,
): WorkstreamListingEntry[] {
  const prefix = `/j/${escapeForRegExp(companyId)}/${escapeForRegExp(slug)}`;
  const re = new RegExp(
    `href="(?:https?://${escapeForRegExp(BOARD_HOST)})?${prefix}/([a-z0-9-]+)/([a-z0-9-]*-([0-9a-f]{8}))(?:[?#][^"]*)?"`,
    "gi",
  );
  const entries: WorkstreamListingEntry[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null = re.exec(html);
  while (m !== null) {
    const location = m[1];
    const role = m[2];
    const jobId = m[3];
    if (location && role && jobId && !seen.has(jobId)) {
      seen.add(jobId);
      // Canonical URL = scheme-normalised board link without query/fragment.
      entries.push({
        sourceId: jobId,
        url: `https://${BOARD_HOST}/j/${companyId}/${slug}/${location}/${role}`,
      });
    }
    m = re.exec(html);
  }
  return entries;
}

export interface ParseWorkstreamJobPageInput {
  readonly tenant: TenantInput;
  readonly company: string;
  readonly url: string;
  readonly sourceId: string;
  readonly html: string;
  readonly observedAt: string;
}

// Build a Job from a job page's JobPosting JSON-LD. Returns null when the
// page carries no JobPosting block or the synthesised row fails validation.
// Titles pass through an entity decode (boards emit `&amp;` for brand
// ampersands); a datePosted after the scrape instant is dropped rather than
// failing the row (the schema requires posted_at <= last_seen_at).
export function parseWorkstreamJobPage(input: ParseWorkstreamJobPageInput): Job | null {
  const jl = extractJobPostingJsonLd(input.html);
  if (!jl) return null;
  const loc = jsonLdLocationText(jl);
  const title = decodeHTML(jl.title);
  const postedRaw =
    jl.datePosted !== undefined ? normalizeJobPostingDate(jl.datePosted) : undefined;
  const postedAt = postedRaw !== undefined && postedRaw <= input.observedAt ? postedRaw : undefined;
  const candidate = buildJob({
    ats: "workstream",
    tenant_slug: input.tenant.slug,
    company: input.company,
    source_id: input.sourceId,
    title,
    url: input.url,
    ...(jl.description !== undefined ? { description_html: jl.description } : {}),
    ...(loc.text !== undefined ? { location_text: loc.text } : {}),
    workplace_hint: loc.text ?? "",
    ...(postedAt !== undefined ? { posted_at: postedAt } : {}),
    is_recruiter_post: isRecruiterTitle(title),
    first_seen_at: input.observedAt,
    last_seen_at: input.observedAt,
  });
  const withCountry =
    loc.country !== undefined ? { ...candidate, location_country: loc.country } : candidate;
  const validated = JobSchema.safeParse(withCountry);
  return validated.success ? validated.data : null;
}

export interface ScrapeWorkstreamOptions {
  readonly tenant: TenantInput;
  readonly client: HttpClient;
  readonly observedAt: string;
  readonly companyId: string;
  readonly maxPages?: number;
  readonly maxDetailFetches?: number;
  readonly maxDegradedRefetches?: number;
  readonly degradedRetryDelayMs?: number;
  // Injectable pacing — tests supply a zero-delay pacer (and a stub sleeper
  // for the degraded backoff) so the paced fan-out replays deterministically.
  // Production callers omit it and share the module-scope pacer.
  readonly pacer?: WorkstreamPacer;
  readonly sleepFn?: (ms: number) => Promise<void>;
}

export interface ScrapeWorkstreamOutcome {
  readonly jobs: ReadonlyArray<Job>;
  readonly result: TenantResult;
}

interface BoardWalkContext {
  readonly client: HttpClient;
  readonly pacer: WorkstreamPacer;
  readonly companyId: string;
  readonly slug: string;
  readonly maxPages: number;
  readonly maxDetail: number;
}

// Walk board pages until a page yields no new links. The SSR pagination nav
// is populated client-side, so the empty past-the-end page (HTTP 200, zero
// position links) is the reliable end-of-board signal. Board pages count
// against the same per-IP rate budget as the job pages that follow, so they
// go through the pacer too.
async function walkBoardPages(
  ctx: BoardWalkContext,
): Promise<{ entries: WorkstreamListingEntry[]; httpStatus: number }> {
  const boardUrl = `https://${BOARD_HOST}/j/${ctx.companyId}/${ctx.slug}/positions`;
  let httpStatus = 0;
  const seen = new Set<string>();
  const entries: WorkstreamListingEntry[] = [];
  for (let page = 1; page <= ctx.maxPages; page++) {
    const url = page === 1 ? boardUrl : `${boardUrl}?page=${page}`;
    const { status, body } = await ctx.pacer.schedule(async () => {
      const res = await ctx.client.request(url);
      return { status: res.status, body: await res.text() };
    });
    httpStatus = status;
    const pageEntries = parseWorkstreamBoardPage(body, ctx.companyId, ctx.slug);
    let added = 0;
    for (const entry of pageEntries) {
      if (seen.has(entry.sourceId)) continue;
      seen.add(entry.sourceId);
      entries.push(entry);
      added += 1;
    }
    if (added === 0) break;
    // Once past the detail cap the truncation is already certain — stop
    // spending board requests on links that will be sliced off anyway.
    if (entries.length > ctx.maxDetail) break;
  }
  return { entries, httpStatus };
}

interface JobFetchContext {
  readonly tenant: TenantInput;
  readonly company: string;
  readonly observedAt: string;
  readonly client: HttpClient;
  readonly pacer: WorkstreamPacer;
  readonly sleep: (ms: number) => Promise<void>;
  readonly degradedRetryDelayMs: number;
  // Draws one re-fetch from the tenant-wide budget; false when it's spent.
  readonly takeRefetch: () => boolean;
}

// Fetch one job page and parse its JobPosting. A 200 without the JobPosting
// block is the rate-limit's degraded render; back off long enough for the
// throttle to lift, then re-fetch before giving up on the role. A page that
// genuinely carries no JobPosting (e.g. a just-filled role) is
// indistinguishable from a degraded one and spends the same re-fetch budget
// — by design, since the degraded render is the overwhelmingly more common
// cause on this host.
async function fetchJobWithRecovery(
  entry: WorkstreamListingEntry,
  ctx: JobFetchContext,
): Promise<Job | null> {
  let attemptsLeft = DEGRADED_REFETCH_ATTEMPTS;
  for (;;) {
    const html = await ctx.pacer.schedule(async () => (await ctx.client.request(entry.url)).text());
    const job = parseWorkstreamJobPage({
      tenant: ctx.tenant,
      company: ctx.company,
      url: entry.url,
      sourceId: entry.sourceId,
      html,
      observedAt: ctx.observedAt,
    });
    if (job !== null) return job;
    if (attemptsLeft <= 0 || !ctx.takeRefetch()) return null;
    attemptsLeft -= 1;
    await ctx.sleep(ctx.degradedRetryDelayMs);
  }
}

export async function scrapeWorkstreamTenant(
  opts: ScrapeWorkstreamOptions,
): Promise<ScrapeWorkstreamOutcome> {
  try {
    assertSafeSlug(opts.tenant.slug);
    assertWorkstreamCompanyId(opts.companyId);
    const company = opts.tenant.display_name ?? opts.tenant.slug;
    const maxDetail = opts.maxDetailFetches ?? MAX_DETAIL_FETCH_PER_TENANT;
    const pacer = opts.pacer ?? SHARED_PACER;
    let refetchBudget = opts.maxDegradedRefetches ?? MAX_DEGRADED_REFETCHES_PER_TENANT;
    let budgetExhausted = false;

    const { entries, httpStatus } = await walkBoardPages({
      client: opts.client,
      pacer,
      companyId: opts.companyId,
      slug: opts.tenant.slug,
      maxPages: opts.maxPages ?? MAX_BOARD_PAGES,
      maxDetail,
    });
    const capped = entries.length > maxDetail;
    const bounded = entries.slice(0, maxDetail);

    // N+1 fan-out. No per-tenant limiter: the shared pacer already
    // serializes every request in the process, and the degraded backoff
    // sleeps outside the pacer so a stalled role never blocks the queue.
    const fetchCtx: JobFetchContext = {
      tenant: opts.tenant,
      company,
      observedAt: opts.observedAt,
      client: opts.client,
      pacer,
      sleep: opts.sleepFn ?? defaultSleep,
      degradedRetryDelayMs: opts.degradedRetryDelayMs ?? DEFAULT_DEGRADED_RETRY_DELAY_MS,
      takeRefetch: () => {
        if (refetchBudget <= 0) {
          budgetExhausted = true;
          return false;
        }
        refetchBudget -= 1;
        return true;
      },
    };
    let pageFailures = 0;
    const collected: Array<Job | null> = await Promise.all(
      bounded.map(async (entry) => {
        try {
          const job = await fetchJobWithRecovery(entry, fetchCtx);
          if (job === null) pageFailures += 1;
          return job;
        } catch {
          pageFailures += 1;
          return null;
        }
      }),
    );

    const jobs = dedupeById(collected.filter((j): j is Job => j !== null));
    // When more than half the board's job pages fail to yield a JobPosting,
    // report the tenant as transient rather than success/0 — that pattern
    // usually means the vendor changed the JSON-LD shape, which we want
    // surfaced in the run-report instead of silently zeroing the row count.
    // The job page is the only source of each role here, matching the other
    // jsonld-core consumers.
    const status: TenantResult["status"] =
      bounded.length > 0 && pageFailures > bounded.length / 2 ? "transient_failure" : "success";
    const errorParts: string[] = [];
    if (capped) {
      errorParts.push(`capped at ${maxDetail} of ${entries.length} discovered roles`);
    }
    if (pageFailures > 0) {
      errorParts.push(
        `${pageFailures}/${bounded.length} job pages failed to parse JSON-LD${
          budgetExhausted ? " (degraded re-fetch budget exhausted)" : ""
        }`,
      );
    }
    return {
      jobs,
      result: {
        slug: opts.tenant.slug,
        status,
        http_status: httpStatus,
        ...(errorParts.length > 0 ? { error: errorParts.join("; ") } : {}),
        jobs_count: jobs.length,
      },
    };
  } catch (err) {
    return { jobs: [], result: errorToResult(opts.tenant.slug, err) };
  }
}
