import { type Job, JobSchema, type TenantInput, type TenantResult } from "@openroles/shared";
import { buildJob } from "../build-job.ts";
import type { HttpClient } from "../http.ts";
import { assertSafeSlug, dedupeById, errorToResult } from "./common.ts";

// ApplicantStack publishes a server-rendered HTML table at
// `https://{slug}.applicantstack.com/x/openings` with one row per job and
// four columns: Title (anchor → /x/detail/{shortcode}), Location, Department,
// Job Type. The shortcode in the detail URL is the stable per-job identifier.
// Description is on the detail page, not in the listing table — fetching
// each detail would multiply requests, so we keep the structured listing
// data as the canonical record (same trade-off as applicantpro).

// Match `<tr ...><td...><a href="https://{host}/x/detail/{shortcode}">{title}</a>
//        </td><td...>{location}</td><td...>{department}</td><td...>{type}</td></tr>`.
// The HTML is single-line (no whitespace-mode `s` flag needed) but the row
// can carry odd-row / even-row classes so we keep the opening tag loose.
const ROW_RE =
  /<tr\b[^>]*>\s*<td[^>]*>\s*<a\s+href="(https:\/\/[a-z0-9-]+\.applicantstack\.com\/x\/detail\/[A-Za-z0-9_-]+)">([^<]+)<\/a>\s*<\/td>\s*<td[^>]*>([^<]*)<\/td>\s*<td[^>]*>([^<]*)<\/td>\s*<td[^>]*>([^<]*)<\/td>/gi;

interface ParsedRow {
  url: string;
  title: string;
  location: string;
  department: string;
  jobType: string;
}

export function parseListingRows(html: string, slug: string): ParsedRow[] {
  const expectedHost = `${slug}.applicantstack.com`;
  const seen = new Set<string>();
  const out: ParsedRow[] = [];
  let m: RegExpExecArray | null = ROW_RE.exec(html);
  while (m !== null) {
    const url = m[1] ?? "";
    const title = m[2]?.trim() ?? "";
    const location = m[3]?.trim() ?? "";
    const department = m[4]?.trim() ?? "";
    const jobType = m[5]?.trim() ?? "";
    // SSRF guard: only accept detail URLs that point at the expected
    // tenant host. The regex already constrains to applicantstack.com,
    // and this check pins the subdomain to {slug}.
    try {
      const parsed = new URL(url);
      if (parsed.host !== expectedHost) {
        m = ROW_RE.exec(html);
        continue;
      }
    } catch {
      m = ROW_RE.exec(html);
      continue;
    }
    if (title.length > 0 && !seen.has(url)) {
      seen.add(url);
      out.push({ url, title, location, department, jobType });
    }
    m = ROW_RE.exec(html);
  }
  return out;
}

function shortcodeFromUrl(url: string): string {
  const tail = url.split("/").filter(Boolean).pop() ?? url;
  return tail;
}

function workplaceFrom(location: string, jobType: string): Job["workplace_type"] {
  const blob = `${location} ${jobType}`.toLowerCase();
  if (/\bremote\b/.test(blob)) return "remote";
  if (/\bhybrid\b/.test(blob)) return "hybrid";
  // ApplicantStack listings show a city/state for onsite roles; treat
  // anything that looks like a place name (and isn't remote/hybrid) as
  // onsite, consistent with the rest of the codebase.
  if (location.length > 0) return "onsite";
  return null;
}

export interface ScrapeApplicantStackOptions {
  readonly tenant: TenantInput;
  readonly client: HttpClient;
  readonly observedAt: string;
}

export interface ScrapeApplicantStackOutcome {
  readonly jobs: ReadonlyArray<Job>;
  readonly result: TenantResult;
}

export async function scrapeApplicantStackTenant(
  opts: ScrapeApplicantStackOptions,
): Promise<ScrapeApplicantStackOutcome> {
  try {
    assertSafeSlug(opts.tenant.slug);
    const url = `https://${opts.tenant.slug}.applicantstack.com/x/openings`;
    const res = await opts.client.request(url);
    const html = await res.text();
    const rows = parseListingRows(html, opts.tenant.slug);
    const company = opts.tenant.display_name ?? opts.tenant.slug;
    const jobs: Job[] = [];
    for (const row of rows) {
      const sourceId = shortcodeFromUrl(row.url);
      const candidate = buildJob({
        ats: "applicantstack",
        tenant_slug: opts.tenant.slug,
        company,
        source_id: sourceId,
        title: row.title,
        url: row.url,
        ...(row.location ? { location_text: row.location } : {}),
        workplace_hint: `${row.location} ${row.jobType}`,
        ...(row.department ? { department: row.department } : {}),
        is_recruiter_post: false,
        first_seen_at: opts.observedAt,
        last_seen_at: opts.observedAt,
      });
      const enriched: Job = {
        ...candidate,
        workplace_type: workplaceFrom(row.location, row.jobType) ?? candidate.workplace_type,
      };
      const validated = JobSchema.safeParse(enriched);
      if (validated.success) jobs.push(validated.data);
    }
    // If the listing HTML carries `/x/detail/` substrings but our row regex
    // matched zero rows, that's a vendor layout change rather than a real
    // empty board — surface transient_failure so the next harvest retries.
    if (rows.length === 0 && /\/x\/detail\//.test(html)) {
      return {
        jobs: [],
        result: {
          slug: opts.tenant.slug,
          status: "transient_failure",
          http_status: res.status,
          error: "listing fetched but no /x/detail/ rows matched the expected layout",
          jobs_count: 0,
        },
      };
    }
    return {
      jobs: dedupeById(jobs),
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
