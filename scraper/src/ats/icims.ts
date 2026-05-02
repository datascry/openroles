import { type Job, JobSchema, type TenantInput, type TenantResult } from "@openroles/shared";
import { XMLParser } from "fast-xml-parser";
import { Parser } from "htmlparser2";
import pLimit from "p-limit";
import { z } from "zod";
import { buildJob } from "../build-job.ts";
import type { HttpClient } from "../http.ts";
import { assertSafeSlug, dedupeById, errorToResult, isRecruiterTitle } from "./common.ts";

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  trimValues: true,
});

export interface SitemapUrl {
  readonly loc: string;
  readonly lastmod: string | undefined;
}

export function parseIcimsSitemap(xml: string): SitemapUrl[] {
  const parsed: unknown = xmlParser.parse(xml);
  const urls: SitemapUrl[] = [];
  if (!isRecord(parsed)) return urls;
  const urlset = parsed["urlset"];
  if (!isRecord(urlset)) return urls;
  const rawList = urlset["url"];
  const entries = Array.isArray(rawList) ? rawList : rawList ? [rawList] : [];
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    const loc = typeof entry["loc"] === "string" ? entry["loc"] : undefined;
    if (loc === undefined) continue;
    const lastmod = typeof entry["lastmod"] === "string" ? entry["lastmod"] : undefined;
    urls.push({ loc, lastmod });
  }
  return urls;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const JsonLdAddress = z
  .object({
    addressLocality: z.string().optional(),
    addressRegion: z.string().optional(),
    addressCountry: z.union([z.string(), z.object({ name: z.string() })]).optional(),
  })
  .optional();

const JsonLdLocation = z
  .object({
    address: JsonLdAddress,
  })
  .optional();

const JsonLdIdentifier = z
  .union([z.string(), z.object({ value: z.union([z.string(), z.number()]).optional() }).optional()])
  .optional();

const JsonLdJobPosting = z
  .object({
    "@type": z.union([z.string(), z.array(z.string())]).optional(),
    title: z.string(),
    description: z.string().optional(),
    datePosted: z.string().optional(),
    employmentType: z.union([z.string(), z.array(z.string())]).optional(),
    hiringOrganization: z.union([z.string(), z.object({ name: z.string().optional() })]).optional(),
    jobLocation: z.union([JsonLdLocation, z.array(JsonLdLocation)]).optional(),
    identifier: JsonLdIdentifier,
    url: z.string().optional(),
  })
  .passthrough();

export type JsonLdJob = z.infer<typeof JsonLdJobPosting>;

/**
 * Extract the first JobPosting JSON-LD block from a page.
 *
 * Parses with htmlparser2 instead of regex. The previous regex
 * (`<script\b[^>]*type=...>([\s\S]*?)</script>`) was flagged by CodeQL
 * (`js/incomplete-multi-character-sanitization`): an HTML comment
 * containing `<script` could fool the regex after the
 * `stripHtmlComments` pre-pass, and the regex itself didn't handle
 * malformed `<script\n type=...>` shapes. The parser tracks element
 * state correctly and ignores comments natively.
 */
export function extractJsonLd(html: string): JsonLdJob | null {
  const blobs: string[] = [];
  let inLdJson = false;
  let buffer = "";
  const parser = new Parser(
    {
      onopentag(name, attribs) {
        if (
          name === "script" &&
          (attribs["type"] === "application/ld+json" ||
            attribs["type"] === "application/ld+json; charset=utf-8")
        ) {
          inLdJson = true;
          buffer = "";
        }
      },
      ontext(text) {
        if (inLdJson) buffer += text;
      },
      onclosetag(name) {
        if (name === "script" && inLdJson) {
          blobs.push(buffer);
          buffer = "";
          inLdJson = false;
        }
      },
    },
    { recognizeSelfClosing: true },
  );
  parser.write(html);
  parser.end();
  for (const blob of blobs) {
    const candidate = parseJsonLdBlob(blob);
    if (candidate) return candidate;
  }
  return null;
}

function parseJsonLdBlob(blob: string): JsonLdJob | null {
  let json: unknown;
  try {
    json = JSON.parse(blob);
  } catch {
    return null;
  }
  const candidates = Array.isArray(json) ? json : [json];
  for (const c of candidates) {
    if (!isRecord(c)) continue;
    const types = c["@type"];
    const isJob = types === "JobPosting" || (Array.isArray(types) && types.includes("JobPosting"));
    if (!isJob) continue;
    const parsed = JsonLdJobPosting.safeParse(c);
    if (parsed.success) return parsed.data;
  }
  return null;
}

function jsonLdLocationText(job: JsonLdJob): {
  text: string | undefined;
  region: string | undefined;
  country: string | undefined;
} {
  const locs = Array.isArray(job.jobLocation)
    ? job.jobLocation
    : job.jobLocation
      ? [job.jobLocation]
      : [];
  for (const loc of locs) {
    if (!loc) continue;
    const addr = loc.address;
    if (!addr) continue;
    const region = addr.addressRegion;
    const country =
      typeof addr.addressCountry === "string" ? addr.addressCountry : addr.addressCountry?.name;
    const parts = [addr.addressLocality, region, country].filter(
      (s): s is string => typeof s === "string" && s.length > 0,
    );
    return {
      text: parts.length > 0 ? parts.join(", ") : undefined,
      region: typeof region === "string" && region.length > 0 ? region : undefined,
      country: typeof country === "string" && country.length === 2 ? country : undefined,
    };
  }
  return { text: undefined, region: undefined, country: undefined };
}

function jsonLdSourceId(job: JsonLdJob, fallbackUrl: string): string {
  if (typeof job.identifier === "string" && job.identifier.length > 0) return job.identifier;
  if (isRecord(job.identifier)) {
    const v = (job.identifier as { value?: string | number }).value;
    if (typeof v === "string" && v.length > 0) return v;
    if (typeof v === "number") return String(v);
  }
  const parts = fallbackUrl.split("/").filter((p) => p.length > 0);
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    if (p && /^\d+$/.test(p)) return p;
  }
  return parts[parts.length - 1] ?? fallbackUrl;
}

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
    ...(jl.datePosted !== undefined ? { posted_at: normalizeDate(jl.datePosted) } : {}),
    is_recruiter_post: isRecruiterTitle(jl.title),
    first_seen_at: input.observedAt,
    last_seen_at: input.observedAt,
  });
  const candidateWithCountry =
    loc.country !== undefined ? { ...candidate, location_country: loc.country } : candidate;
  const validated = JobSchema.safeParse(candidateWithCountry);
  return validated.success ? validated.data : null;
}

function normalizeDate(v: string): string {
  if (/^\d{4}-\d{2}-\d{2}T/.test(v)) return v;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return `${v}T00:00:00Z`;
  return v;
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
