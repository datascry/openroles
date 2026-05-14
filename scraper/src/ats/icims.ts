import { type Job, JobSchema, type TenantInput, type TenantResult } from "@openroles/shared";
import pLimit from "p-limit";
import { buildJob } from "../build-job.ts";
import type { HttpClient } from "../http.ts";
import { assertSafeSlug, dedupeById, errorToResult, isRecruiterTitle } from "./common.ts";
import {
  extractJobPostingJsonLd as extractJsonLd,
  isRecord,
  type JsonLdJob,
  jsonLdLocationText,
  jsonLdSourceId,
  normalizeJobPostingDate,
  parseSitemapXml as parseIcimsSitemap,
  type SitemapUrl,
} from "./jsonld-core.ts";

export type { JsonLdJob, SitemapUrl };
// Re-export the JSON-LD primitives under the iCIMS-prefixed names that
// existing callers (tests, downstream tooling) import. The names are
// stable across the 2026-05-14 extraction of the shared core; only the
// import path changes for anyone reaching into icims internals.
export { extractJsonLd, parseIcimsSitemap };

export interface IcimsParseInput {
  readonly tenant: TenantInput;
  readonly company: string;
  readonly url: string;
  readonly html: string;
  readonly observedAt: string;
}

export function parseIcimsJobPage(input: IcimsParseInput): Job | null {
  const jl = extractJsonLd(input.html);
  if (!jl) return null;
  const loc = jsonLdLocationText(jl);
  const candidate = buildJob({
    ats: "icims",
    tenant_slug: input.tenant.slug,
    company:
      isRecord(jl.hiringOrganization) && typeof jl.hiringOrganization.name === "string"
        ? jl.hiringOrganization.name
        : input.company,
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

export interface ScrapeIcimsOptions {
  readonly tenant: TenantInput;
  readonly client: HttpClient;
  readonly observedAt: string;
  readonly perTenantConcurrency?: number;
  readonly maxJobPages?: number;
}

export interface ScrapeTenantOutcome {
  readonly jobs: ReadonlyArray<Job>;
  readonly result: TenantResult;
}

// Per-tenant fan-out for the per-job HTML fetches kicked off after the
// sitemap parse. Bumped from 4 -> 8 to halve icims wallclock: 14k tenants
// × ~10-50 jobs each = ~250k HTTP requests total, dominated by per-host
// TLS+DNS for jobs hosted on `${slug}.icims.com`. Each fetch is to the
// same subdomain so connection reuse helps; 8 concurrent doesn't pressure
// any single host.
const DEFAULT_PER_TENANT_CONCURRENCY = 8;
const DEFAULT_MAX_JOB_PAGES = 1000;

export async function scrapeIcimsTenant(opts: ScrapeIcimsOptions): Promise<ScrapeTenantOutcome> {
  let sitemapStatus = 0;
  try {
    assertSafeSlug(opts.tenant.slug);
    const expectedHost = `${opts.tenant.slug}.icims.com`;
    const sitemapUrl = `https://${expectedHost}/sitemap.xml`;
    const sitemapRes = await opts.client.request(sitemapUrl);
    sitemapStatus = sitemapRes.status;
    const xml = await sitemapRes.text();
    // SSRF guard: a hostile or compromised sitemap can list arbitrary URLs.
    // Restrict per-job fetches to the expected tenant host so an attacker
    // cannot pivot the scraper into internal addresses.
    const jobUrls = parseIcimsSitemap(xml)
      .map((e) => e.loc)
      .filter((u) => {
        try {
          const parsed = new URL(u);
          return (
            parsed.host === expectedHost &&
            parsed.protocol === "https:" &&
            /\/jobs\//i.test(parsed.pathname)
          );
        } catch {
          return false;
        }
      })
      .slice(0, opts.maxJobPages ?? DEFAULT_MAX_JOB_PAGES);
    const limit = pLimit(opts.perTenantConcurrency ?? DEFAULT_PER_TENANT_CONCURRENCY);
    let pageFailures = 0;
    const collected: Array<Job | null> = await Promise.all(
      jobUrls.map((u) =>
        limit(async () => {
          try {
            const res = await opts.client.request(u);
            const html = await res.text();
            const parsedJob = parseIcimsJobPage({
              tenant: opts.tenant,
              company: opts.tenant.display_name ?? opts.tenant.slug,
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
    const status: TenantResult["status"] =
      jobUrls.length > 0 && pageFailures > jobUrls.length / 2 ? "transient_failure" : "success";
    return {
      jobs,
      result: {
        slug: opts.tenant.slug,
        status,
        http_status: sitemapStatus,
        ...(pageFailures > 0
          ? { error: `${pageFailures}/${jobUrls.length} job pages failed` }
          : {}),
        jobs_count: jobs.length,
      },
    };
  } catch (err) {
    return { jobs: [], result: errorToResult(opts.tenant.slug, err) };
  }
}
