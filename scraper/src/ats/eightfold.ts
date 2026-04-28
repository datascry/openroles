import { type Job, JobSchema, jobId, type TenantInput, type TenantResult } from "@openroles/shared";
import { XMLParser } from "fast-xml-parser";
import pLimit from "p-limit";
import type { HttpClient } from "../http.ts";
import { assertSafeSlug, dedupeById, errorToResult } from "./common.ts";

// Eightfold publishes a public sitemap at
// `https://{slug}.eightfold.ai/careers/sitemap.xml`. The sitemap entries
// point at the customer's branded careers subdomain (e.g.
// `careers.10xgenomics.com`) — not back at `{slug}.eightfold.ai`.
// Each detail page embeds a schema.org `JobPosting` block as JSON-LD with
// title, description (markdown), datePosted, validThrough, employmentType,
// hiringOrganization, and jobLocation.

interface SitemapEntry {
  loc?: string;
  lastmod?: string;
}

interface SitemapXml {
  urlset?: { url?: SitemapEntry | SitemapEntry[] };
}

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  trimValues: true,
});

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseSitemap(xml: string): string[] {
  const parsed = xmlParser.parse(xml) as SitemapXml;
  const raw = parsed.urlset?.url;
  const entries: ReadonlyArray<SitemapEntry> = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const urls: string[] = [];
  for (const e of entries) {
    if (!isRecord(e)) continue;
    const loc = e["loc"];
    if (typeof loc === "string") urls.push(loc);
  }
  return urls;
}

interface JobLdAddress {
  addressLocality?: string;
  addressRegion?: string;
  addressCountry?: string | { name?: string };
}

interface JobLdLocation {
  address?: JobLdAddress;
}

interface JobLdOrg {
  name?: string;
}

interface JobLdJobPosting {
  "@type"?: string | string[];
  title?: string;
  description?: string;
  datePosted?: string;
  validThrough?: string;
  employmentType?: string;
  hiringOrganization?: string | JobLdOrg;
  jobLocation?: JobLdLocation | JobLdLocation[];
  url?: string;
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
      // skip malformed JSON-LD
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

const SOURCE_ID_RE = /\/careers\/job\/(\d{6,16})\b/;

function sourceIdFromUrl(url: string): string {
  const m = SOURCE_ID_RE.exec(url);
  if (m?.[1]) return m[1];
  // Fallback: the trailing path segment before any query.
  const tail = url.split("?")[0]?.split("/").filter(Boolean).pop() ?? url;
  return tail;
}

// Eightfold's sitemap intentionally lists URLs on the customer's branded
// `careers.{domain}` subdomain rather than `{slug}.eightfold.ai`. SSRF
// guard accepts only HTTPS URLs whose hostname starts with `careers.` and
// whose path is `/careers/job/{numeric-id}-...` — the canonical detail
// shape. Anything else (sitemap-index entries, the careers landing page,
// arbitrary hosts) is rejected.
function isAllowedDetailUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (
      u.protocol === "https:" &&
      u.hostname.startsWith("careers.") &&
      /^\/careers\/job\/\d{6,16}\b/.test(u.pathname)
    );
  } catch {
    return false;
  }
}

export interface ScrapeEightfoldOptions {
  readonly tenant: TenantInput;
  readonly client: HttpClient;
  readonly observedAt: string;
  readonly perTenantConcurrency?: number;
}

export interface ScrapeEightfoldOutcome {
  readonly jobs: ReadonlyArray<Job>;
  readonly result: TenantResult;
}

const DEFAULT_CONCURRENCY = 4;
const MAX_JOBS_PER_TENANT = 500;

export async function scrapeEightfoldTenant(
  opts: ScrapeEightfoldOptions,
): Promise<ScrapeEightfoldOutcome> {
  let sitemapStatus = 0;
  try {
    assertSafeSlug(opts.tenant.slug);
    const sitemapUrl = `https://${opts.tenant.slug}.eightfold.ai/careers/sitemap.xml`;
    const sitemapRes = await opts.client.request(sitemapUrl);
    sitemapStatus = sitemapRes.status;
    const xml = await sitemapRes.text();
    const all = parseSitemap(xml);
    const jobUrls = all.filter(isAllowedDetailUrl).slice(0, MAX_JOBS_PER_TENANT);
    if (jobUrls.length === 0) {
      return {
        jobs: [],
        result: {
          slug: opts.tenant.slug,
          status: "success",
          http_status: sitemapStatus,
          jobs_count: 0,
        },
      };
    }

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
            ats: "eightfold",
            tenant_slug: opts.tenant.slug,
            source_id: sourceId,
            url,
          });
          const loc = locationFromJobLd(ld);
          const desc = ld.description?.trim();
          const orgName =
            typeof ld.hiringOrganization === "string"
              ? ld.hiringOrganization
              : ld.hiringOrganization?.name;
          const candidate = {
            id,
            ats: "eightfold",
            tenant_slug: opts.tenant.slug,
            source_id: sourceId,
            title: ld.title,
            company: orgName ?? company,
            ...(desc && desc.length > 0 ? { description_excerpt: desc.slice(0, 4000) } : {}),
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
