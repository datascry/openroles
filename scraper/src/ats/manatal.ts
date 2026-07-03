import { type Job, JobSchema, type TenantInput, type TenantResult } from "@openroles/shared";
import pLimit from "p-limit";
import { buildJob } from "../build-job.ts";
import type { HttpClient } from "../http.ts";
import {
  assertSafeSlug,
  dedupeById,
  errorToResult,
  isRecruiterTitle,
  vendorDateToIsoZ,
} from "./common.ts";
import { extractJobPostingJsonLd, jsonLdLocationText } from "./jsonld-core.ts";

// Manatal hosted career boards. Every customer board lives on the single
// shared host `www.careers-page.com` at `/{slug}`, which server-renders a
// flat list of `<a href="/{slug}/job/{code}">` links — one per open role.
// The board carries no structured data and there is no list JSON endpoint,
// so the board HTML is parsed for the (relative-href) job codes and each job
// page (`/{slug}/job/{code}`) is then fetched for its one
// `schema.org/JobPosting` JSON-LD block (emitted for Google for Jobs), read
// through the shared jsonld-core extractor rather than by scraping the
// rendered HTML.
//
// Tenant identity is just the slug: the board host is constant and the
// per-job URL is `www.careers-page.com/{slug}/job/{code}`, so no extra
// metadata is needed (unlike workday/oraclecloud). This is the same
// board-listing + JSON-LD-detail shape as jazzhr/workstream, minus their
// board pagination — the whole board renders on one page.

const BOARD_HOST = "www.careers-page.com";

// Per-tenant detail fan-out bounds. Manatal customers are recruitment
// agencies and SMBs (single- to low-hundreds of roles); the cap protects
// against a pathological board while the concurrency limit respects the
// single shared `www.careers-page.com` backend every tenant resolves to.
// Because the job page is the only source of each role, board entries beyond
// the cap are dropped outright (not merely de-enriched); when the cap bites,
// the truncation is surfaced in TenantResult.error rather than reported as a
// clean success. 400 sits well above the largest verified seed (~50), so this
// is a backstop, not a routine truncation.
const MAX_DETAIL_FETCH_PER_TENANT = 400;
const DEFAULT_PER_TENANT_CONCURRENCY = 6;

function escapeForRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface ManatalListingEntry {
  readonly sourceId: string;
  readonly url: string;
}

// Extract the (jobCode, canonical job URL) of every role linked from a
// tenant's board page. The board emits root-relative hrefs
// (`href="/{slug}/job/{code}"`), so matching is anchored to the tenant's own
// `/{slug}/job/` prefix — a cross-tenant link, the board's own root link, or
// an asset path can never be mistaken for a job. Deduped by jobCode: the
// board repeats each role's link across the card title and its apply button.
export function parseManatalListing(html: string, slug: string): ManatalListingEntry[] {
  const re = new RegExp(`href="/${escapeForRegExp(slug)}/job/([A-Za-z0-9]+)(?:[?#][^"]*)?"`, "gi");
  const entries: ManatalListingEntry[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null = re.exec(html);
  while (m !== null) {
    const code = m[1];
    if (code && !seen.has(code)) {
      seen.add(code);
      entries.push({
        sourceId: code,
        url: `https://${BOARD_HOST}/${slug}/job/${code}`,
      });
    }
    m = re.exec(html);
  }
  return entries;
}

export interface ParseManatalJobPageInput {
  readonly tenant: TenantInput;
  readonly company: string;
  readonly url: string;
  readonly sourceId: string;
  readonly html: string;
  readonly observedAt: string;
}

// Build a Job from a job page's JobPosting JSON-LD. Returns null when the
// page carries no JobPosting block or the synthesised row fails validation.
// Manatal emits `datePosted` as a microsecond ISO timestamp with a numeric
// UTC offset (`2026-07-01T10:50:36.151464+00:00`), so it is normalised to the
// canonical trailing-Z shape via `vendorDateToIsoZ` (a plain `Date` round-trip)
// rather than the sitemap-oriented `normalizeJobPostingDate`, whose fast path
// would return the offset form verbatim and fail JobSchema's IsoUtc guard. A
// datePosted after the scrape instant is dropped rather than failing the row
// (the schema requires posted_at <= last_seen_at) — Manatal's dates are
// occasionally mis-seeded into the future.
export function parseManatalJobPage(input: ParseManatalJobPageInput): Job | null {
  const jl = extractJobPostingJsonLd(input.html);
  if (!jl) return null;
  const loc = jsonLdLocationText(jl);
  const postedRaw = vendorDateToIsoZ(jl.datePosted);
  const postedAt = postedRaw !== undefined && postedRaw <= input.observedAt ? postedRaw : undefined;
  const candidate = buildJob({
    ats: "manatal",
    tenant_slug: input.tenant.slug,
    company: input.company,
    source_id: input.sourceId,
    title: jl.title,
    url: input.url,
    ...(jl.description !== undefined ? { description_html: jl.description } : {}),
    ...(loc.text !== undefined ? { location_text: loc.text } : {}),
    workplace_hint: loc.text ?? "",
    ...(postedAt !== undefined ? { posted_at: postedAt } : {}),
    is_recruiter_post: isRecruiterTitle(jl.title),
    first_seen_at: input.observedAt,
    last_seen_at: input.observedAt,
  });
  const withCountry =
    loc.country !== undefined ? { ...candidate, location_country: loc.country } : candidate;
  const validated = JobSchema.safeParse(withCountry);
  return validated.success ? validated.data : null;
}

export interface ScrapeManatalOptions {
  readonly tenant: TenantInput;
  readonly client: HttpClient;
  readonly observedAt: string;
  readonly perTenantConcurrency?: number;
  readonly maxDetailFetches?: number;
}

export interface ScrapeManatalOutcome {
  readonly jobs: ReadonlyArray<Job>;
  readonly result: TenantResult;
}

export async function scrapeManatalTenant(
  opts: ScrapeManatalOptions,
): Promise<ScrapeManatalOutcome> {
  try {
    assertSafeSlug(opts.tenant.slug);
    const company = opts.tenant.display_name ?? opts.tenant.slug;
    const maxDetail = opts.maxDetailFetches ?? MAX_DETAIL_FETCH_PER_TENANT;
    const boardUrl = `https://${BOARD_HOST}/${opts.tenant.slug}`;
    const listingRes = await opts.client.request(boardUrl);
    const httpStatus = listingRes.status;
    const listingHtml = await listingRes.text();
    const discovered = parseManatalListing(listingHtml, opts.tenant.slug);
    const capped = discovered.length > maxDetail;
    const bounded = discovered.slice(0, maxDetail);

    const limit = pLimit(opts.perTenantConcurrency ?? DEFAULT_PER_TENANT_CONCURRENCY);
    let pageFailures = 0;
    const collected: Array<Job | null> = await Promise.all(
      bounded.map((entry) =>
        limit(async () => {
          try {
            const res = await opts.client.request(entry.url);
            const html = await res.text();
            const job = parseManatalJobPage({
              tenant: opts.tenant,
              company,
              url: entry.url,
              sourceId: entry.sourceId,
              html,
              observedAt: opts.observedAt,
            });
            if (job === null) pageFailures += 1;
            return job;
          } catch {
            pageFailures += 1;
            return null;
          }
        }),
      ),
    );

    const jobs = dedupeById(collected.filter((j): j is Job => j !== null));
    // When more than half the board's job pages fail to yield a JobPosting,
    // report the tenant as transient rather than success/0 — that pattern
    // usually means Manatal changed the JSON-LD shape (or stopped emitting
    // it), which we want surfaced in the run-report instead of silently
    // zeroing the row count. The job page is the only source of each role
    // here, matching the other jsonld-core consumers (jazzhr/workstream).
    const status: TenantResult["status"] =
      bounded.length > 0 && pageFailures > bounded.length / 2 ? "transient_failure" : "success";
    const errorParts: string[] = [];
    if (capped) {
      errorParts.push(`capped at ${maxDetail} of ${discovered.length} discovered roles`);
    }
    if (pageFailures > 0) {
      errorParts.push(`${pageFailures}/${bounded.length} job pages failed to parse JSON-LD`);
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
