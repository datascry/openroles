import { type Job, JobSchema, type TenantInput, type TenantResult } from "@openroles/shared";
import pLimit from "p-limit";
import { buildJob } from "../build-job.ts";
import type { HttpClient } from "../http.ts";
import {
  assertSafeSlug,
  dedupeById,
  errorToResult,
  isRecruiterTitle,
  isSafeFetchHost,
} from "./common.ts";
import {
  extractJobPostingJsonLd,
  jsonLdLocationText,
  jsonLdSourceId,
  normalizeJobPostingDate,
  parseSitemapXml,
} from "./jsonld-core.ts";

// Vendor-agnostic JSON-LD harvester. Walks a tenant-supplied sitemap,
// fetches each page, and extracts `schema.org/JobPosting` JSON-LD blocks.
//
// Tenant identity = (slug, sitemap_url). The slug names the brand; the
// sitemap_url is a full URL to a sitemap.xml the brand exposes for SEO
// (Google for Jobs ingestion). The platform under the hood is opaque —
// this adapter unlocks brands whose careers stack is proprietary but
// who serve the standardised JSON-LD payload anyway.
//
// Shares its parsing core with the iCIMS adapter via `jsonld-core.ts`:
// both walk a sitemap.xml and extract JobPosting JSON-LD. iCIMS gates
// per-job fetches to a slug-derived host (`{slug}.icims.com`); this
// adapter gates them to whatever host the tenant-supplied sitemap URL
// resolves to. The two adapters differ only in those orchestration
// decisions — the JSON-LD shape and the sitemap shape are identical.

// Public alias preserved for backward compatibility with the
// jsonld.test.ts surface that existed before the core was extracted.
export const parseJsonldSitemap = parseSitemapXml;

// The core schema types are re-exported through icims.ts (the older
// caller); imports here use the core module directly.
export type { JsonLdJob, SitemapUrl } from "./jsonld-core.ts";
export { extractJobPostingJsonLd } from "./jsonld-core.ts";

export interface ParseJsonldJobPageInput {
  readonly tenant: TenantInput;
  readonly company: string;
  readonly url: string;
  readonly html: string;
  readonly observedAt: string;
}

/**
 * Extract a single Job from a page's JSON-LD. Returns null when:
 * - no JobPosting JSON-LD is present;
 * - the JSON-LD is malformed; or
 * - the synthesised Job fails JobSchema validation.
 *
 * Pure; deterministic; safe to property-test.
 */
export function parseJsonldJobPage(input: ParseJsonldJobPageInput): Job | null {
  const jl = extractJobPostingJsonLd(input.html);
  if (!jl) return null;
  const loc = jsonLdLocationText(jl);
  // hiringOrganization.name is unreliable across vendors (e.g. TalentBrew
  // emits the BU/department name, not the brand). Fall back to the
  // tenant's configured display_name / slug for `company` to keep the
  // surfaced brand consistent with the rest of the corpus.
  const candidate = buildJob({
    ats: "jsonld",
    tenant_slug: input.tenant.slug,
    company: input.company,
    source_id: jsonLdSourceId(jl, input.url),
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
  const candidateWithCountry =
    loc.country !== undefined ? { ...candidate, location_country: loc.country } : candidate;
  const validated = JobSchema.safeParse(candidateWithCountry);
  return validated.success ? validated.data : null;
}

export interface ScrapeJsonldOptions {
  readonly tenant: TenantInput;
  readonly client: HttpClient;
  readonly observedAt: string;
  readonly sitemapUrl: string;
  readonly perTenantConcurrency?: number;
}

export interface ScrapeJsonldOutcome {
  readonly jobs: ReadonlyArray<Job>;
  readonly result: TenantResult;
}

// Conservative per-tenant fan-out. The brands seeded here are large
// (Lockheed 3,933 jobs; AT&T 1,724; Spectrum 1,387; Comcast 990 at
// time of seeding). 4 concurrent connections per host respects shared
// hosting headers without spiking error rates. Matches iCIMS's previous
// default before it was raised to 8 for cross-tenant scale.
//
// There is intentionally no per-tenant job-count cap. The whole point
// of the harvester is maximum coverage of the seeded brand; capping
// truncates real jobs (Lockheed's ~4K sitemap would lose 75% of its
// roles to a 1000-job cap). The dispatcher's overall pLimit + the
// per-tenant concurrency above bound the request rate; the SSRF guard
// bounds the blast radius of a hostile sitemap. Time budget concerns
// are addressed at the dispatcher level (--concurrency, retry policy),
// not by truncating per-tenant rolls.
const DEFAULT_PER_TENANT_CONCURRENCY = 4;

/**
 * Validates that a URL is suitable for fetching as a per-job page:
 * - safe host (no loopback / RFC1918 / metadata IPs — see
 *   `isSafeFetchHost`);
 * - same host as the sitemap (SSRF guard against compromised sitemaps);
 * - https only (enforced by isSafeFetchHost);
 * - path looks job-shaped (`/job/` or `/jobs/` segment) — filters out
 *   the brand's other content URLs that may share the sitemap (privacy
 *   policies, about pages, etc.). Exposed for testing the rejection
 *   surface independently of the orchestrator.
 */
export function isJsonldJobUrl(candidate: string, expectedHost: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return false;
  }
  if (!isSafeFetchHost(parsed)) return false;
  if (parsed.host !== expectedHost) return false;
  return /\/jobs?\//i.test(parsed.pathname);
}

export async function scrapeJsonldTenant(opts: ScrapeJsonldOptions): Promise<ScrapeJsonldOutcome> {
  let sitemapStatus = 0;
  try {
    assertSafeSlug(opts.tenant.slug);
    let parsedSitemap: URL;
    try {
      parsedSitemap = new URL(opts.sitemapUrl);
    } catch {
      return {
        jobs: [],
        result: {
          slug: opts.tenant.slug,
          status: "dead",
          error: `invalid sitemap_url: ${JSON.stringify(opts.sitemapUrl)}`,
          jobs_count: 0,
        },
      };
    }
    // Same SSRF guard the probe builder applies (audit M-2). A hostile
    // tenant record with `metadata.sitemap_url = "https://192.168.1.1/..."`
    // or `"http://..."` must be rejected before any GET fires.
    if (!isSafeFetchHost(parsedSitemap)) {
      return {
        jobs: [],
        result: {
          slug: opts.tenant.slug,
          status: "dead",
          error: `unsafe sitemap_url host: ${JSON.stringify(parsedSitemap.host)}`,
          jobs_count: 0,
        },
      };
    }
    const expectedHost = parsedSitemap.host;
    const sitemapRes = await opts.client.request(opts.sitemapUrl);
    sitemapStatus = sitemapRes.status;
    const xml = await sitemapRes.text();
    const jobUrls = parseJsonldSitemap(xml)
      .map((e) => e.loc)
      .filter((u) => isJsonldJobUrl(u, expectedHost));
    const limit = pLimit(opts.perTenantConcurrency ?? DEFAULT_PER_TENANT_CONCURRENCY);
    const company = opts.tenant.display_name ?? opts.tenant.slug;
    let pageFailures = 0;
    const collected: Array<Job | null> = await Promise.all(
      jobUrls.map((u) =>
        limit(async () => {
          try {
            const res = await opts.client.request(u);
            const html = await res.text();
            const parsedJob = parseJsonldJobPage({
              tenant: opts.tenant,
              company,
              url: u,
              html,
              observedAt: opts.observedAt,
            });
            if (parsedJob === null) pageFailures += 1;
            return parsedJob;
          } catch {
            pageFailures += 1;
            return null;
          }
        }),
      ),
    );
    const jobs = dedupeById(collected.filter((j): j is Job => j !== null));
    // Treat a tenant as transient when more than half its job pages
    // failed to parse — that usually means the vendor changed the
    // JSON-LD shape, which we want to surface via the run-report rather
    // than silently zeroing the row count.
    const status: TenantResult["status"] =
      jobUrls.length > 0 && pageFailures > jobUrls.length / 2 ? "transient_failure" : "success";
    return {
      jobs,
      result: {
        slug: opts.tenant.slug,
        status,
        http_status: sitemapStatus,
        ...(pageFailures > 0
          ? { error: `${pageFailures}/${jobUrls.length} job pages failed to parse JSON-LD` }
          : {}),
        jobs_count: jobs.length,
      },
    };
  } catch (err) {
    return { jobs: [], result: errorToResult(opts.tenant.slug, err) };
  }
}
