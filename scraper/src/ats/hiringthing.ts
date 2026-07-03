import { type Job, JobSchema, type TenantInput, type TenantResult } from "@openroles/shared";
import { XMLParser } from "fast-xml-parser";
import { buildJob } from "../build-job.ts";
import type { HttpClient } from "../http.ts";
import { assertSafeSlug, dedupeById, errorToResult, isRecruiterTitle } from "./common.ts";

// HiringThing hosted job boards. Every customer board lives at
// `{slug}.hiringthing.com` and publishes an RSS 2.0 feed at
// `/api/rss.xml` (media namespace); every <item> is a complete
// listing entry:
//
//   <item>
//     <title>Account Manager, Raleigh | Events, Exhibits</title>
//     <link>https://pinnacle.hiringthing.com/job/1033869/account-manager-…</link>
//     <description>plain-text teaser, ellipsis-truncated…</description>
//     <category/>
//     <location>Raleigh, NC</location>
//     <media:description type="html"><![CDATA[ …full job HTML… ]]></media:description>
//   </item>
//
// One GET per tenant covers the whole board — no pagination, no
// per-job fan-out. The numeric job id rides in the link path
// (`/job/{id}/{title-slug}`) and is the stable source identity. The
// feed carries no pubDate, so posted_at is intentionally omitted
// (same posture as hrmdirect). Tenant identity = slug (subdomain);
// no metadata is required. Boards on white-label custom domains are
// out of scope — slug boards only.

const FEED_PATH = "/api/rss.xml";

// The numeric job id inside a board link: `/job/{id}/{title-slug}`
// (the trailing title-slug segment is optional on hand-typed links).
const JOB_ID_IN_LINK = /\/job\/(\d+)(?:[/?#]|$)/;

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  trimValues: true,
});

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// fast-xml-parser coerces numeric-looking element text to `number` and
// wraps attribute-carrying elements (media:description type="html") in
// `{ "#text": …, "@_attr": … }`. Normalise both to a trimmed non-empty
// string, or undefined.
function textOf(v: unknown): string | undefined {
  if (typeof v === "string") {
    const t = v.trim();
    return t.length > 0 ? t : undefined;
  }
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (isRecord(v)) return textOf(v["#text"]);
  return undefined;
}

export interface ParseHiringthingInput {
  readonly tenant: TenantInput;
  readonly company: string;
  readonly xml: string;
  readonly observedAt: string;
}

/**
 * Parse a HiringThing board RSS feed into normalized Job records.
 * Pure; deterministic; never throws — malformed XML yields [].
 */
export function parseHiringthingFeed(input: ParseHiringthingInput): Job[] {
  const slug = input.tenant.slug;
  const host = `${slug}.hiringthing.com`;
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
    const link = textOf(item["link"]);
    // The link's numeric /job/{id}/ segment is the only stable identity
    // the feed carries (no guid) — an item without it is skipped.
    const sourceId = link !== undefined ? JOB_ID_IN_LINK.exec(link)?.[1] : undefined;
    if (title === undefined || link === undefined || sourceId === undefined) continue;
    // Trust the item link only when it sits on the tenant's own board
    // host; otherwise compose the canonical board URL from the id so a
    // feed misconfigured with an off-host link can't plant a foreign URL.
    const url = linkOnHost(link, host) ? link : `https://${host}/job/${sourceId}`;
    // media:description holds the full job HTML (CDATA); the bare
    // description is an ellipsis-truncated teaser — prefer the former.
    const description = textOf(item["media:description"]) ?? textOf(item["description"]);
    const location = textOf(item["location"]);
    const candidate = buildJob({
      ats: "hiringthing",
      tenant_slug: slug,
      company: input.company,
      source_id: sourceId,
      title,
      url,
      ...(description !== undefined ? { description_html: description } : {}),
      ...(location !== undefined ? { location_text: location } : {}),
      // No structured workplace field in the feed — boards encode
      // "Remote" in the title or the location text, so hint on both.
      workplace_hint: `${title} ${location ?? ""}`,
      // The feed carries no pubDate — posted_at is intentionally omitted.
      is_recruiter_post: isRecruiterTitle(title),
      first_seen_at: input.observedAt,
      last_seen_at: input.observedAt,
    });
    const validated = JobSchema.safeParse(candidate);
    if (validated.success) out.push(validated.data);
  }
  return dedupeById(out);
}

// True when `link` parses and its host is exactly the tenant board host.
function linkOnHost(link: string, host: string): boolean {
  try {
    return new URL(link).host.toLowerCase() === host;
  } catch {
    return false;
  }
}

export interface ScrapeHiringthingOptions {
  readonly tenant: TenantInput;
  readonly client: HttpClient;
  readonly observedAt: string;
}

export interface ScrapeHiringthingOutcome {
  readonly jobs: ReadonlyArray<Job>;
  readonly result: TenantResult;
}

export async function scrapeHiringthingTenant(
  opts: ScrapeHiringthingOptions,
): Promise<ScrapeHiringthingOutcome> {
  try {
    assertSafeSlug(opts.tenant.slug);
    const host = `${opts.tenant.slug}.hiringthing.com`;
    const company = opts.tenant.display_name ?? opts.tenant.slug;
    const res = await opts.client.request(`https://${host}${FEED_PATH}`);
    const xml = await res.text();
    const jobs = parseHiringthingFeed({
      tenant: opts.tenant,
      company,
      xml,
      observedAt: opts.observedAt,
    });
    // A 2xx feed with an empty channel is a real state for a live board
    // (a tenant with nothing open still serves the channel envelope), so
    // zero jobs is success — dead subdomains never reach here: they
    // bounce cross-host to the vendor landing page and fail the fetch.
    return {
      jobs,
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
