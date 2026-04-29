import { type Job, JobSchema, jobId, type TenantInput, type TenantResult } from "@openroles/shared";
import pLimit from "p-limit";
import type { HttpClient } from "../http.ts";
import { assertSafeSlug, dedupeById, errorToResult } from "./common.ts";

// Jobvite tenants serve a public listing page at `https://jobs.jobvite.com/{slug}`
// with each row formatted as
//
//   <td class="jv-job-list-name">
//     <a href="/{slug}/job/{shortcode}">{title}</a>
//   </td>
//
// Each detail page (`/{slug}/job/{shortcode}`) embeds a schema.org
// `JobPosting` block as JSON-LD, identical to the structure talentlyft uses.

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
  industry?: string;
  identifier?: string | { value?: string | number; name?: string };
  url?: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
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
      // ignore malformed JSON-LD blocks
    }
    m = re.exec(html);
  }
  return null;
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

const HREF_RE = /<td[^>]*class="[^"]*\bjv-job-list-name\b[^"]*"[^>]*>\s*<a\b[^>]*href="([^"]+)"/gi;

export function parseListingHrefs(html: string, slug: string): string[] {
  // SSRF guard: only accept links that point under `/{slug}/job/{shortcode}`,
  // matching the documented public layout. Anything else (absolute URLs to
  // other hosts, parent paths, fragments) is rejected.
  const expectedPrefix = `/${slug}/job/`;
  const seen = new Set<string>();
  const out: string[] = [];
  let m: RegExpExecArray | null = HREF_RE.exec(html);
  while (m !== null) {
    const href = m[1] ?? "";
    if (
      href.startsWith(expectedPrefix) &&
      /^\/[a-z0-9-]+\/job\/[A-Za-z0-9]+$/.test(href.split("?")[0] ?? "") &&
      !seen.has(href)
    ) {
      seen.add(href);
      out.push(href);
    }
    m = HREF_RE.exec(html);
  }
  return out;
}

function shortcodeFromPath(path: string): string {
  const tail = path.split("?")[0]?.split("/").pop() ?? path;
  return tail;
}

export interface ScrapeJobviteOptions {
  readonly tenant: TenantInput;
  readonly client: HttpClient;
  readonly observedAt: string;
  readonly perTenantConcurrency?: number;
}

export interface ScrapeJobviteOutcome {
  readonly jobs: ReadonlyArray<Job>;
  readonly result: TenantResult;
}

const DEFAULT_CONCURRENCY = 4;
const MAX_JOBS_PER_TENANT = 500;

export async function scrapeJobviteTenant(
  opts: ScrapeJobviteOptions,
): Promise<ScrapeJobviteOutcome> {
  let listingStatus = 0;
  try {
    assertSafeSlug(opts.tenant.slug);
    const listingUrl = `https://jobs.jobvite.com/${opts.tenant.slug}`;
    const listingRes = await opts.client.request(listingUrl);
    listingStatus = listingRes.status;
    const listingHtml = await listingRes.text();
    const hrefs = parseListingHrefs(listingHtml, opts.tenant.slug).slice(0, MAX_JOBS_PER_TENANT);
    if (hrefs.length === 0) {
      // The listing page returned 2xx but our row regex matched zero hrefs.
      // If the HTML contains `/job/` substrings we likely missed a vendor
      // change in the row layout — surface transient_failure so the next
      // harvest retries instead of committing a misleading success-with-zero.
      // Otherwise it's a genuine empty board (real outcome): success/0.
      const hasJobMarkers = /\/job\//.test(listingHtml);
      return {
        jobs: [],
        result: {
          slug: opts.tenant.slug,
          status: hasJobMarkers ? "transient_failure" : "success",
          http_status: listingStatus,
          ...(hasJobMarkers
            ? { error: "listing fetched but no /job/ rows matched the expected layout" }
            : {}),
          jobs_count: 0,
        },
      };
    }

    const limit = pLimit(opts.perTenantConcurrency ?? DEFAULT_CONCURRENCY);
    const company = opts.tenant.display_name ?? opts.tenant.slug;
    let okCount = 0;
    let failCount = 0;
    const tasks = hrefs.map((href) =>
      limit(async (): Promise<Job | null> => {
        const url = `https://jobs.jobvite.com${href}`;
        try {
          const res = await opts.client.request(url);
          const html = await res.text();
          const ld = extractJsonLd(html);
          if (!ld?.title) {
            failCount++;
            return null;
          }
          const sourceId = shortcodeFromPath(href);
          const id = jobId({
            ats: "jobvite",
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
            ats: "jobvite",
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
            ...(ld.industry ? { department: ld.industry } : {}),
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

    // Mirror talentlyft / icims: when most per-job fetches fail, the listing
    // is fine but the detail pages aren't reachable — surface as
    // transient_failure so the next harvest retries.
    const total = okCount + failCount;
    if (total > 0 && failCount > total * 0.5) {
      return {
        jobs: [],
        result: {
          slug: opts.tenant.slug,
          status: "transient_failure",
          http_status: listingStatus,
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
        http_status: listingStatus,
        jobs_count: jobs.length,
      },
    };
  } catch (err) {
    return { jobs: [], result: errorToResult(opts.tenant.slug, err) };
  }
}
