import { type Job, JobSchema, jobId, type TenantInput, type TenantResult } from "@openroles/shared";
import { XMLParser } from "fast-xml-parser";
import pLimit from "p-limit";
import type { HttpClient } from "../http.ts";
import { assertSafeSlug, dedupeById, errorToResult } from "./common.ts";

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  trimValues: true,
});

interface JobLdLocation {
  address?: {
    addressLocality?: string;
    addressRegion?: string;
    addressCountry?: string | { name?: string };
  };
}

interface JobLdJobPosting {
  "@type"?: string | string[];
  title?: string;
  description?: string;
  datePosted?: string;
  validThrough?: string;
  employmentType?: string | string[];
  hiringOrganization?: string | { name?: string };
  jobLocation?: JobLdLocation | JobLdLocation[];
  identifier?: string | { value?: string | number; name?: string };
  url?: string;
  baseSalary?: {
    currency?: string;
    value?: { minValue?: number; maxValue?: number; unitText?: string };
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseSitemap(xml: string): string[] {
  const parsed = xmlParser.parse(xml) as { urlset?: { url?: unknown } };
  const raw = parsed.urlset?.url;
  const entries = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const urls: string[] = [];
  for (const e of entries) {
    if (!isRecord(e)) continue;
    const loc = e["loc"];
    if (typeof loc === "string") urls.push(loc);
  }
  return urls;
}

function extractJsonLd(html: string): JobLdJobPosting | null {
  const re = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null = re.exec(html);
  while (m !== null) {
    try {
      const blob = (m[1] ?? "").trim();
      const json = JSON.parse(blob) as unknown;
      const candidates = Array.isArray(json) ? json : [json];
      for (const c of candidates) {
        if (!isRecord(c)) continue;
        const t = c["@type"];
        const isJob = t === "JobPosting" || (Array.isArray(t) && t.includes("JobPosting"));
        if (isJob && typeof c["title"] === "string") return c as JobLdJobPosting;
      }
    } catch {
      // skip malformed JSON-LD blocks
    }
    m = re.exec(html);
  }
  return null;
}

function locationFromJobLd(job: JobLdJobPosting): {
  text?: string;
  region?: string;
  country?: string;
} {
  const locs = Array.isArray(job.jobLocation)
    ? job.jobLocation
    : job.jobLocation
      ? [job.jobLocation]
      : [];
  for (const loc of locs) {
    const addr = loc?.address;
    if (!addr) continue;
    const country =
      typeof addr.addressCountry === "string" ? addr.addressCountry : addr.addressCountry?.name;
    const parts = [addr.addressLocality, addr.addressRegion, country].filter(
      (s): s is string => typeof s === "string" && s.length > 0,
    );
    return {
      ...(parts.length > 0 ? { text: parts.join(", ") } : {}),
      ...(addr.addressRegion ? { region: addr.addressRegion } : {}),
      ...(typeof country === "string" && country.length === 2 ? { country } : {}),
    };
  }
  return {};
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, "/")
    .replace(/&#xA0;|&nbsp;/g, " ");
}

function sourceIdFromUrl(url: string): string {
  // Talentlyft job URLs end with `/jobs/{slug}-{shortId}` where shortId is
  // a short alphanumeric like `ccn7`. Extract the trailing token after the
  // last hyphen as the stable identifier; fall back to the whole tail.
  const parts = url.split("/").filter((p) => p.length > 0);
  const tail = parts[parts.length - 1] ?? url;
  const m = tail.match(/[-_]([A-Za-z0-9]{3,10})$/);
  return m?.[1] ?? tail;
}

export interface ScrapeTalentlyftOptions {
  readonly tenant: TenantInput;
  readonly client: HttpClient;
  readonly observedAt: string;
  readonly perTenantConcurrency?: number;
}

export interface ScrapeTalentlyftOutcome {
  readonly jobs: ReadonlyArray<Job>;
  readonly result: TenantResult;
}

const DEFAULT_CONCURRENCY = 4;
const MAX_JOBS_PER_TENANT = 500;

export async function scrapeTalentlyftTenant(
  opts: ScrapeTalentlyftOptions,
): Promise<ScrapeTalentlyftOutcome> {
  let sitemapStatus = 0;
  try {
    assertSafeSlug(opts.tenant.slug);
    const expectedHost = `${opts.tenant.slug}.talentlyft.com`;
    const sitemapUrl = `https://${expectedHost}/sitemap.xml`;
    const sitemapRes = await opts.client.request(sitemapUrl);
    sitemapStatus = sitemapRes.status;
    const xml = await sitemapRes.text();
    const allUrls = parseSitemap(xml);
    // SSRF guard: a hostile or compromised sitemap can list arbitrary URLs.
    // Restrict per-job fetches to the expected tenant host so an attacker
    // cannot pivot the scraper into internal/metadata addresses.
    const jobUrls = allUrls
      .filter((u) => {
        try {
          const parsed = new URL(u);
          return (
            parsed.host === expectedHost &&
            parsed.protocol === "https:" &&
            parsed.pathname.includes("/jobs/") &&
            !parsed.pathname.endsWith("/jobs/")
          );
        } catch {
          return false;
        }
      })
      .slice(0, MAX_JOBS_PER_TENANT);

    const limit = pLimit(opts.perTenantConcurrency ?? DEFAULT_CONCURRENCY);
    const company = opts.tenant.display_name ?? opts.tenant.slug;
    let okCount = 0;
    let failCount = 0;
    const tasks = jobUrls.map((url) =>
      limit(async (): Promise<Job | null> => {
        try {
          const res = await opts.client.request(url);
          const html = await res.text();
          const ld = extractJsonLd(html);
          if (!ld?.title) {
            failCount++;
            return null;
          }
          const sourceId = sourceIdFromUrl(url);
          const id = jobId({
            ats: "talentlyft",
            tenant_slug: opts.tenant.slug,
            source_id: sourceId,
            url,
          });
          const loc = locationFromJobLd(ld);
          const decodedDesc = ld.description
            ? decodeHtmlEntities(ld.description).trim()
            : undefined;
          const desc =
            decodedDesc && decodedDesc.length > 0 ? decodedDesc.slice(0, 4000) : undefined;
          const orgName =
            typeof ld.hiringOrganization === "string"
              ? ld.hiringOrganization
              : ld.hiringOrganization?.name;
          const candidate = {
            id,
            ats: "talentlyft",
            tenant_slug: opts.tenant.slug,
            source_id: sourceId,
            title: ld.title,
            company: orgName ?? company,
            ...(desc ? { description_excerpt: desc } : {}),
            level: null,
            level_rank: null,
            workplace_type: null,
            is_recruiter_post: false,
            ...(loc.text ? { location_text: loc.text } : {}),
            ...(loc.region ? { location_region: loc.region } : {}),
            ...(loc.country ? { location_country: loc.country } : {}),
            ...(ld.datePosted ? { posted_at: new Date(ld.datePosted).toISOString() } : {}),
            first_seen_at: opts.observedAt,
            last_seen_at: opts.observedAt,
            url,
          };
          const validated = JobSchema.safeParse(candidate);
          if (!validated.success) {
            failCount++;
            return null;
          }
          okCount++;
          return validated.data;
        } catch {
          failCount++;
          return null;
        }
      }),
    );
    const settled = await Promise.all(tasks);
    const jobs = settled.filter((j): j is Job => j !== null);

    // Mirror iCIMS: when most per-job fetches fail, the sitemap is fine but
    // the job pages aren't reachable — surface as transient_failure rather
    // than success-with-zero-rows so the next harvest retries.
    const total = okCount + failCount;
    if (total > 0 && failCount > total * 0.5) {
      return {
        jobs: [],
        result: {
          slug: opts.tenant.slug,
          status: "transient_failure",
          http_status: sitemapStatus,
          error: `${failCount} of ${total} job pages failed to parse`,
          jobs_count: 0,
        },
      };
    }
    return {
      jobs: dedupeById(jobs),
      result: {
        slug: opts.tenant.slug,
        status: "success",
        http_status: sitemapStatus,
        jobs_count: jobs.length,
      },
    };
  } catch (err) {
    return { jobs: [], result: errorToResult(opts.tenant.slug, err) };
  }
}
