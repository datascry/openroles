import { type Job, JobSchema, type TenantInput, type TenantResult } from "@openroles/shared";
import { XMLParser } from "fast-xml-parser";
import pLimit from "p-limit";
import { buildJob } from "../build-job.ts";
import type { HttpClient } from "../http.ts";
import { assertSafeSlug, dedupeById, errorToResult } from "./common.ts";

// Factorial publishes a public sitemap at `https://{slug}.factorialhr.com/sitemap.xml`
// listing every job_posting URL. Detail pages don't carry JSON-LD, but they
// do expose `<meta property="og:title">` (the job title) and the full body
// content for the description. The trailing numeric token of the URL slug
// (e.g. `senior-engineer-294697`) is the stable per-job identifier.

interface SitemapEntry {
  loc?: string;
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

// Match `<meta content='...' [name='title'] property='og:title'>`. The
// content body can include newlines (factorial pads with a trailing newline
// before the closing quote), but it cannot include `>` — using `[^>]*?`
// instead of `[\s\S]*?` keeps the lazy match bounded to a single tag so it
// can't span past one meta tag's `>` into the next tag's content.
//
// Factorial sometimes emits attributes in `property=...content=...` order
// instead of the dominant `content=...property=...`; we accept either.
const OG_TITLE_RES = [
  /<meta\s+content=(['"])([^>]*?)\1\s+(?:[^>]*?\s+)?property=(['"])og:title\3/i,
  /<meta\s+(?:[^>]*?\s+)?property=(['"])og:title\1\s+(?:[^>]*?\s+)?content=(['"])([^>]*?)\2/i,
];
const OG_DESC_RES = [
  /<meta\s+content=(['"])([^>]*?)\1\s+(?:[^>]*?\s+)?property=(['"])og:description\3/i,
  /<meta\s+(?:[^>]*?\s+)?property=(['"])og:description\1\s+(?:[^>]*?\s+)?content=(['"])([^>]*?)\2/i,
];

function pickAttrGroup(re: RegExp, html: string): string | undefined {
  const m = re.exec(html);
  if (!m) return undefined;
  // Whichever ordering matched, the value is the only capture group whose
  // text isn't a quote character — pick the longest non-quote group.
  for (const g of [m[2], m[3]]) {
    if (typeof g === "string" && g.length > 1) return g;
  }
  return undefined;
}

function extractOgTitle(html: string): string | undefined {
  for (const re of OG_TITLE_RES) {
    const raw = pickAttrGroup(re, html)?.trim();
    if (raw && raw.length > 0) return raw;
  }
  // No `<title>` fallback: that tag commonly carries " | Acme Corp"
  // suffixes or page-level boilerplate ("Apply here") that pollutes the
  // job title field. Prefer to skip the row and let the >50% threshold
  // trip transient_failure if the entire batch is og:title-less.
  return undefined;
}

function extractOgDescription(html: string): string | undefined {
  for (const re of OG_DESC_RES) {
    const raw = pickAttrGroup(re, html)?.trim();
    // Factorial's og:description is a boilerplate "Apply today to X job
    // offer and join the Y team" — useful only when no body content is
    // available. Keep it as a last-resort fallback.
    if (raw && raw.length > 0) return raw;
  }
  return undefined;
}

// Lift a paragraph-and-list block out of the post body. Factorial wraps the
// description in unstructured HTML (no canonical container class), so we
// take the slice from the first `<p>` after the H1 to the apply button as a
// best-effort extract. If we can't find boundaries, fall back to og:description.
const POST_BODY_RE = /<\/h1>([\s\S]*?)<a\b[^>]*\/apply\//i;

function extractBody(html: string): string | undefined {
  const m = POST_BODY_RE.exec(html);
  const slice = m?.[1]?.trim();
  return slice && slice.length > 0 ? slice : undefined;
}

function sourceIdFromUrl(url: string): string {
  // Factorial job URLs end with `{slug}-{numericId}`; the numeric tail is
  // the stable identifier we want. Falls back to the whole tail when the
  // URL doesn't match.
  const tail =
    url
      .split("/")
      .filter((p) => p.length > 0)
      .pop() ?? url;
  const match = tail.match(/-(\d{3,12})$/);
  return match?.[1] ?? tail;
}

export interface ScrapeFactorialOptions {
  readonly tenant: TenantInput;
  readonly client: HttpClient;
  readonly observedAt: string;
  readonly perTenantConcurrency?: number;
}

export interface ScrapeFactorialOutcome {
  readonly jobs: ReadonlyArray<Job>;
  readonly result: TenantResult;
}

const DEFAULT_CONCURRENCY = 4;
const MAX_JOBS_PER_TENANT = 500;

export async function scrapeFactorialTenant(
  opts: ScrapeFactorialOptions,
): Promise<ScrapeFactorialOutcome> {
  let sitemapStatus = 0;
  try {
    assertSafeSlug(opts.tenant.slug);
    const expectedHost = `${opts.tenant.slug}.factorialhr.com`;
    const sitemapUrl = `https://${expectedHost}/sitemap.xml`;
    const sitemapRes = await opts.client.request(sitemapUrl);
    sitemapStatus = sitemapRes.status;
    const xml = await sitemapRes.text();
    const all = parseSitemap(xml);
    // SSRF guard: the sitemap may list arbitrary URLs. Restrict per-job
    // fetches to the expected tenant host.
    const jobUrls = all
      .filter((u) => {
        try {
          const parsed = new URL(u);
          return (
            parsed.host === expectedHost &&
            parsed.protocol === "https:" &&
            parsed.pathname.startsWith("/job_posting/") &&
            parsed.pathname !== "/job_posting/"
          );
        } catch {
          return false;
        }
      })
      .slice(0, MAX_JOBS_PER_TENANT);

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
          const title = extractOgTitle(html);
          if (!title) {
            failCount++;
            return null;
          }
          const sourceId = sourceIdFromUrl(url);
          const body = extractBody(html);
          const desc = body ?? extractOgDescription(html);
          const candidate = buildJob({
            ats: "factorial",
            tenant_slug: opts.tenant.slug,
            company,
            source_id: sourceId,
            title,
            url,
            ...(desc ? { description_html: desc } : {}),
            is_recruiter_post: false,
            first_seen_at: opts.observedAt,
            last_seen_at: opts.observedAt,
          });
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

    // Mirror talentlyft / icims: when most per-job fetches fail, surface
    // transient_failure so the next harvest retries.
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
