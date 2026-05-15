import { type Job, JobSchema, type TenantInput, type TenantResult } from "@openroles/shared";
import { XMLParser } from "fast-xml-parser";
import { buildJob } from "../build-job.ts";
import type { HttpClient } from "../http.ts";
import {
  assertSafeSlug,
  dedupeById,
  errorToResult,
  isRecruiterTitle,
  isSafeFetchHost,
} from "./common.ts";

// Google for Jobs RSS feed harvester. Vendor-agnostic, like jsonld:
// tenant identity = (slug, feed_url). The feed is an RSS 2.0 document
// in the http://base.google.com/ns/1.0 namespace; every <item> is a
// complete posting:
//
//   <item>
//     <title>2026UKH - Lead Power Quantitative Risk Modeler (London, LND, GB)</title>
//     <description><![CDATA[ …full job HTML… ]]></description>
//     <link>https://jobs.exxonmobil.com/ExxonMobil/job/…/1367059400/</link>
//     <guid isPermaLink="false">1367059400</guid>
//     <g:id>1367059400</g:id>
//     <g:expiration_date>2026-06-14</g:expiration_date>
//     <g:employer>ExxonMobil</g:employer>
//     <g:job_function>Finance, accounting and tax</g:job_function>
//     <g:location>London, LND, GB</g:location>
//   </item>
//
// One GET, no per-job fan-out (the feed is self-contained). See
// specs/gjobsfeed-adapter.md.

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  trimValues: true,
});

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// fast-xml-parser coerces numeric-looking element text to `number`
// (g:id 1367059400) and wraps elements carrying attributes in
// `{ "#text": …, "@_attr": … }` (guid). Normalise both to a trimmed
// non-empty string, or undefined.
function textOf(v: unknown): string | undefined {
  if (typeof v === "string") {
    const t = v.trim();
    return t.length > 0 ? t : undefined;
  }
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (isRecord(v)) return textOf(v["#text"]);
  return undefined;
}

export interface ParseGjobsfeedInput {
  readonly tenant: TenantInput;
  readonly company: string;
  readonly xml: string;
  readonly observedAt: string;
}

/**
 * Parse a Google-for-Jobs RSS feed into normalized Job records.
 * Pure; deterministic; never throws — malformed XML yields [].
 */
export function parseGjobsfeed(input: ParseGjobsfeedInput): Job[] {
  let parsed: unknown;
  try {
    parsed = xmlParser.parse(input.xml);
  } catch {
    return [];
  }
  if (!isRecord(parsed)) return [];
  const rss = parsed["rss"];
  if (!isRecord(rss)) return [];
  const channel = rss["channel"];
  if (!isRecord(channel)) return [];
  const rawItems = channel["item"];
  const items = Array.isArray(rawItems) ? rawItems : rawItems ? [rawItems] : [];

  const out: Job[] = [];
  for (const item of items) {
    if (!isRecord(item)) continue;
    const title = textOf(item["title"]);
    // g:id is the stable identity; guid duplicates it; link is the last
    // resort so a feed that drops g:id still yields rows keyed by URL.
    const sourceId = textOf(item["g:id"]) ?? textOf(item["guid"]) ?? textOf(item["link"]);
    const url = textOf(item["link"]);
    if (title === undefined || sourceId === undefined || url === undefined) continue;
    const description = textOf(item["description"]);
    const location = textOf(item["g:location"]);
    const department = textOf(item["g:job_function"]);
    const candidate = buildJob({
      ats: "gjobsfeed",
      tenant_slug: input.tenant.slug,
      company: input.company,
      source_id: sourceId,
      title,
      url,
      ...(description !== undefined ? { description_html: description } : {}),
      ...(location !== undefined ? { location_text: location } : {}),
      workplace_hint: location ?? "",
      ...(department !== undefined ? { department } : {}),
      // The Google feed carries g:expiration_date, never a post date —
      // posted_at is intentionally omitted (see spec).
      is_recruiter_post: isRecruiterTitle(title),
      first_seen_at: input.observedAt,
      last_seen_at: input.observedAt,
    });
    const validated = JobSchema.safeParse(candidate);
    if (validated.success) out.push(validated.data);
  }
  return dedupeById(out);
}

export interface ScrapeGjobsfeedOptions {
  readonly tenant: TenantInput;
  readonly client: HttpClient;
  readonly observedAt: string;
  readonly feedUrl: string;
}

export interface ScrapeGjobsfeedOutcome {
  readonly jobs: ReadonlyArray<Job>;
  readonly result: TenantResult;
}

export async function scrapeGjobsfeedTenant(
  opts: ScrapeGjobsfeedOptions,
): Promise<ScrapeGjobsfeedOutcome> {
  try {
    assertSafeSlug(opts.tenant.slug);
    let parsedFeed: URL;
    try {
      parsedFeed = new URL(opts.feedUrl);
    } catch {
      return {
        jobs: [],
        result: {
          slug: opts.tenant.slug,
          status: "dead",
          error: `invalid feed_url: ${JSON.stringify(opts.feedUrl)}`,
          jobs_count: 0,
        },
      };
    }
    // Same SSRF guard the probe builder applies: https only, no
    // loopback / RFC1918 / metadata-IP exfil targets.
    if (!isSafeFetchHost(parsedFeed)) {
      return {
        jobs: [],
        result: {
          slug: opts.tenant.slug,
          status: "dead",
          error: `unsafe feed_url host: ${JSON.stringify(parsedFeed.host)}`,
          jobs_count: 0,
        },
      };
    }
    const res = await opts.client.request(opts.feedUrl);
    const xml = await res.text();
    const company = opts.tenant.display_name ?? opts.tenant.slug;
    const jobs = parseGjobsfeed({
      tenant: opts.tenant,
      company,
      xml,
      observedAt: opts.observedAt,
    });
    // Zero jobs from a 2xx feed is treated as transient (an upstream
    // blip or a momentarily empty feed) rather than dead — the seed
    // stays in rotation and the next run retries. A non-2xx fetch
    // throws inside client.request and lands in the catch below.
    const status: TenantResult["status"] = jobs.length > 0 ? "success" : "transient_failure";
    return {
      jobs,
      result: {
        slug: opts.tenant.slug,
        status,
        http_status: res.status,
        jobs_count: jobs.length,
      },
    };
  } catch (err) {
    return { jobs: [], result: errorToResult(opts.tenant.slug, err) };
  }
}
