import { type Job, JobSchema, type TenantInput, type TenantResult } from "@openroles/shared";
import pLimit from "p-limit";
import { buildJob } from "../build-job.ts";
import type { HttpClient } from "../http.ts";
import { assertSafeSlug, dedupeById, errorToResult, isRecruiterTitle } from "./common.ts";
import {
  extractJobPostingJsonLd,
  jsonLdLocationText,
  normalizeJobPostingDate,
} from "./jsonld-core.ts";

// JazzHR (formerly The Resumator). Every customer gets a public hosted job
// board at `{slug}.applytojob.com/apply/`, which server-renders a flat list
// of `<a href=".../apply/{jobCode}/{title-slug}">` links — one per open
// role. Each job page then carries a complete `schema.org/JobPosting`
// JSON-LD block (JazzHR emits it for Google for Jobs), so the per-job
// detail is read through the shared jsonld-core extractor rather than by
// scraping the rendered HTML.
//
// Tenant identity is just the slug: the board host is `{slug}.applytojob.com`
// and the per-job URL is the canonical apply link, so no extra metadata is
// needed (unlike workday/oraclecloud). This is the same listing+detail shape
// as smartrecruiters, with JSON-LD standing in for a detail JSON API.

const APPLY_BOARD_PATH = "/apply/";

// Per-tenant detail fan-out bounds. JazzHR customers are overwhelmingly SMBs
// (single- to low-hundreds of roles); the cap protects against a pathological
// board while the concurrency limit respects the shared `app.jazz.co` backend
// every tenant subdomain resolves to. Because the job page is the only source
// of each role, board entries beyond the cap are dropped outright (not merely
// de-enriched) — 400 sits comfortably above the largest verified seed (~70),
// so this is a backstop, not a routine truncation.
const MAX_DETAIL_FETCH_PER_TENANT = 400;
const DEFAULT_PER_TENANT_CONCURRENCY = 6;

function escapeForRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface JazzHrListingEntry {
  readonly sourceId: string;
  readonly url: string;
}

// Extract the (jobCode, canonical apply URL) of every role linked from a
// tenant's board page. Matching is anchored to the tenant's own host so a
// stray cross-tenant or asset link can never be mistaken for a job. Deduped
// by jobCode — the board repeats a link in both the heading and any
// "apply" button.
export function parseJazzHrListing(html: string, host: string): JazzHrListingEntry[] {
  const re = new RegExp(
    `href="(https?://${escapeForRegExp(host)}/apply/([A-Za-z0-9]{4,})(?:/[^"\\s]*)?)"`,
    "gi",
  );
  const entries: JazzHrListingEntry[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null = re.exec(html);
  while (m !== null) {
    const full = m[1];
    const code = m[2];
    if (code && full && !seen.has(code)) {
      seen.add(code);
      // Canonical URL = scheme-normalised apply link without query/fragment.
      const url = `https://${host}/apply/${code}${slugSuffix(full, code)}`;
      entries.push({ sourceId: code, url });
    }
    m = re.exec(html);
  }
  return entries;
}

// Preserve the human-readable title slug segment (`/{code}/Senior-Engineer`)
// when present, dropping any query string — it is the exact path the public
// board links to and that renders the job card (HTTP 200).
function slugSuffix(fullUrl: string, code: string): string {
  const afterCode = fullUrl.split(`/apply/${code}`)[1] ?? "";
  const clean = afterCode.split(/[?#]/)[0] ?? "";
  return clean.startsWith("/") ? clean : "";
}

export interface ParseJazzHrJobPageInput {
  readonly tenant: TenantInput;
  readonly company: string;
  readonly url: string;
  readonly sourceId: string;
  readonly html: string;
  readonly observedAt: string;
}

// Build a Job from a job page's JobPosting JSON-LD. Returns null when the
// page carries no JobPosting block or the synthesised row fails validation.
export function parseJazzHrJobPage(input: ParseJazzHrJobPageInput): Job | null {
  const jl = extractJobPostingJsonLd(input.html);
  if (!jl) return null;
  const loc = jsonLdLocationText(jl);
  const candidate = buildJob({
    ats: "jazzhr",
    tenant_slug: input.tenant.slug,
    company: input.company,
    source_id: input.sourceId,
    title: jl.title,
    url: input.url,
    ...(jl.description !== undefined ? { description_html: jl.description } : {}),
    ...(loc.text !== undefined ? { location_text: loc.text } : {}),
    workplace_hint: loc.text ?? "",
    ...(jl.datePosted !== undefined ? { posted_at: normalizeJobPostingDate(jl.datePosted) } : {}),
    is_recruiter_post: isRecruiterTitle(jl.title),
    first_seen_at: input.observedAt,
    last_seen_at: input.observedAt,
  });
  const withCountry =
    loc.country !== undefined ? { ...candidate, location_country: loc.country } : candidate;
  const validated = JobSchema.safeParse(withCountry);
  return validated.success ? validated.data : null;
}

export interface ScrapeJazzHrOptions {
  readonly tenant: TenantInput;
  readonly client: HttpClient;
  readonly observedAt: string;
  readonly perTenantConcurrency?: number;
}

export interface ScrapeJazzHrOutcome {
  readonly jobs: ReadonlyArray<Job>;
  readonly result: TenantResult;
}

export async function scrapeJazzHrTenant(opts: ScrapeJazzHrOptions): Promise<ScrapeJazzHrOutcome> {
  try {
    assertSafeSlug(opts.tenant.slug);
    const host = `${opts.tenant.slug}.applytojob.com`;
    const company = opts.tenant.display_name ?? opts.tenant.slug;
    const listingRes = await opts.client.request(`https://${host}${APPLY_BOARD_PATH}`);
    const httpStatus = listingRes.status;
    const listingHtml = await listingRes.text();
    const entries = parseJazzHrListing(listingHtml, host).slice(0, MAX_DETAIL_FETCH_PER_TENANT);

    const limit = pLimit(opts.perTenantConcurrency ?? DEFAULT_PER_TENANT_CONCURRENCY);
    let pageFailures = 0;
    const collected: Array<Job | null> = await Promise.all(
      entries.map((entry) =>
        limit(async () => {
          try {
            const res = await opts.client.request(entry.url);
            const html = await res.text();
            const job = parseJazzHrJobPage({
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
    // usually means JazzHR changed the JSON-LD shape, which we want surfaced
    // in the run-report instead of silently zeroing the row count. The job
    // page is the only source of each role here, so this mirrors the
    // icims / jsonld siblings that share jsonld-core (and unlike
    // smartrecruiters, where detail is mere enrichment).
    const status: TenantResult["status"] =
      entries.length > 0 && pageFailures > entries.length / 2 ? "transient_failure" : "success";
    return {
      jobs,
      result: {
        slug: opts.tenant.slug,
        status,
        http_status: httpStatus,
        ...(pageFailures > 0
          ? { error: `${pageFailures}/${entries.length} job pages failed to parse JSON-LD` }
          : {}),
        jobs_count: jobs.length,
      },
    };
  } catch (err) {
    return { jobs: [], result: errorToResult(opts.tenant.slug, err) };
  }
}
