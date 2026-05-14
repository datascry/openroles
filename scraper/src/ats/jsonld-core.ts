import { XMLParser } from "fast-xml-parser";
import { Parser } from "htmlparser2";
import { z } from "zod";

// Shared core for ATSes that ingest job listings via sitemap.xml +
// schema.org/JobPosting JSON-LD on individual job pages. Two adapters
// consume this surface today:
//
//   - iCIMS (single-vendor): sitemap URL is derived from the tenant
//     slug (`{slug}.icims.com/sitemap.xml`); per-job fetches are gated
//     to that same `{slug}.icims.com` host.
//   - jsonld (vendor-agnostic): sitemap URL comes from tenant metadata;
//     per-job fetches are gated to whatever host that URL resolves to.
//
// Everything below is pure parsing — no HTTP, no DOM, no per-vendor
// quirks. Both callers compose this with their own orchestration
// (SSRF guard, sitemap discovery, per-job HTTP fan-out) above.

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  trimValues: true,
});

export interface SitemapUrl {
  readonly loc: string;
  readonly lastmod: string | undefined;
}

/**
 * Parse a sitemaps.org urlset or sitemapindex XML into `[{loc, lastmod}]`.
 * Returns an empty array on malformed input — never throws.
 *
 * Both root shapes are treated uniformly; the caller can recurse into
 * `<sitemap>` index entries if it wants index-walking behaviour.
 */
export function parseSitemapXml(xml: string): SitemapUrl[] {
  const urls: SitemapUrl[] = [];
  let parsed: unknown;
  try {
    // fast-xml-parser throws on unclosed tags and a few other shapes
    // (`"<"`, `"<foo"`); the contract here is "never throws", so the
    // failure mode is "parse nothing, return []" rather than letting
    // the caller's per-tenant Promise.all reject.
    parsed = xmlParser.parse(xml);
  } catch {
    return urls;
  }
  if (!isRecord(parsed)) return urls;
  const root = parsed["urlset"] ?? parsed["sitemapindex"];
  if (!isRecord(root)) return urls;
  const entryKey = "url" in root ? "url" : "sitemap";
  const rawList = root[entryKey];
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

export function isRecord(v: unknown): v is Record<string, unknown> {
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
 * Extract the first JobPosting JSON-LD block from a page. Uses
 * htmlparser2 (state machine) rather than regex so HTML comments and
 * malformed-but-valid script tags can't fool the scanner. Returns null
 * when no JobPosting is present.
 *
 * Pages can carry multiple `<script type="application/ld+json">`
 * blocks (e.g. BreadcrumbList + Organization + JobPosting). Each block
 * may itself be an array of typed objects. We scan every block, parse
 * each, and return the first object whose `@type` is "JobPosting" (or
 * an array containing "JobPosting").
 *
 * CodeQL flagged the previous regex implementation
 * (`js/incomplete-multi-character-sanitization`); the parser tracks
 * element state correctly and ignores comments natively.
 */
export function extractJobPostingJsonLd(html: string): JsonLdJob | null {
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

/**
 * Extract (text, region, country) from a JobPosting's jobLocation.
 * Returns the first usable location when the field is an array.
 * `country` is returned only when it's a 2-letter ISO code; longer
 * forms (e.g. "United States") fall into `text` but not `country`.
 */
export function jsonLdLocationText(job: JsonLdJob): {
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

/**
 * Resolve a stable source_id from the JSON-LD identifier field. Falls
 * back to a trailing-digit token in the URL when the identifier is
 * missing (some vendors do not emit it).
 */
export function jsonLdSourceId(job: JsonLdJob, fallbackUrl: string): string {
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

/**
 * Normalise a vendor-supplied datePosted string to the canonical
 * Z-suffixed UTC ISO shape JobSchema enforces.
 *
 * Real-world emitters produce three shapes:
 *   - ISO 8601 with `T` separator (`2026-04-23T08:00:00Z`)
 *   - `YYYY-MM-DD` (zero-padded)
 *   - `YYYY-M-D` (single-digit month/day — seen in TalentBrew payloads)
 *
 * The first form is returned verbatim. The second form is anchored to
 * UTC midnight. Anything else is round-tripped via `Date.parse()`; if
 * that fails the caller decides whether to drop the field. Note that
 * before this helper was extracted, the iCIMS variant rejected
 * single-digit dates — moving the iCIMS adapter onto this helper
 * widens its acceptance to match jsonld's behaviour.
 */
export function normalizeJobPostingDate(v: string): string {
  if (/^\d{4}-\d{2}-\d{2}T/.test(v)) return v;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return `${v}T00:00:00Z`;
  const parsed = new Date(v);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  return v;
}
