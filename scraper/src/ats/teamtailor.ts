import { type Job, JobSchema, jobId, type TenantInput, type TenantResult } from "@openroles/shared";
import { XMLParser } from "fast-xml-parser";
import type { HttpClient } from "../http.ts";
import { decodeHtmlEntities } from "../normalize.ts";
import { assertSafeSlug, dedupeById, errorToResult } from "./common.ts";

interface TeamtailorLocation {
  "tt:name"?: string;
  "tt:city"?: string;
  "tt:country"?: string;
}

interface TeamtailorLocations {
  "tt:location"?: TeamtailorLocation | TeamtailorLocation[];
}

interface TeamtailorItem {
  title?: string;
  description?: string;
  link?: string;
  pubDate?: string;
  guid?: string;
  remoteStatus?: string;
  "tt:locations"?: TeamtailorLocations;
  "tt:department"?: string;
  "tt:role"?: string;
}

interface TeamtailorRss {
  rss?: {
    channel?: {
      title?: string;
      item?: TeamtailorItem | TeamtailorItem[];
    };
  };
}

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  trimValues: true,
});

function workplaceFrom(value: string | undefined): Job["workplace_type"] {
  switch (value?.toLowerCase()) {
    case "remote":
    case "fully-remote":
      return "remote";
    case "hybrid":
      return "hybrid";
    case "onsite":
    case "on-site":
    case "office":
      return "onsite";
    default:
      return null;
  }
}

function rfc2822ToIso(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

function firstLocation(locs: TeamtailorLocations | undefined): TeamtailorLocation | undefined {
  if (!locs?.["tt:location"]) return undefined;
  const raw = locs["tt:location"];
  return Array.isArray(raw) ? raw[0] : raw;
}

function decodeXmlText(html: string): string {
  // Truncated HTML payload kept; downstream excerpt rendering strips tags
  // when needed. Single-pass decode via shared helper avoids the
  // double-decoding flagged by CodeQL `js/double-escaping`.
  return decodeHtmlEntities(html);
}

export interface ScrapeTeamtailorOptions {
  readonly tenant: TenantInput;
  readonly client: HttpClient;
  readonly observedAt: string;
}

export interface ScrapeTeamtailorOutcome {
  readonly jobs: ReadonlyArray<Job>;
  readonly result: TenantResult;
}

export async function scrapeTeamtailorTenant(
  opts: ScrapeTeamtailorOptions,
): Promise<ScrapeTeamtailorOutcome> {
  try {
    assertSafeSlug(opts.tenant.slug);
    const url = `https://${opts.tenant.slug}.teamtailor.com/jobs.rss`;
    const res = await opts.client.request(url);
    const xml = await res.text();
    const parsed = xmlParser.parse(xml) as TeamtailorRss;
    const channel = parsed.rss?.channel;
    const company = channel?.title ?? opts.tenant.display_name ?? opts.tenant.slug;
    const raw = channel?.item;
    const items: TeamtailorItem[] = Array.isArray(raw) ? raw : raw ? [raw] : [];
    const jobs: Job[] = [];
    for (const item of items) {
      const sourceId = item.guid;
      if (!sourceId || !item.title || !item.link) continue;
      const id = jobId({
        ats: "teamtailor",
        tenant_slug: opts.tenant.slug,
        source_id: sourceId,
        url: item.link,
      });
      const loc = firstLocation(item["tt:locations"]);
      const postedAt = rfc2822ToIso(item.pubDate);
      const decodedDesc = item.description ? decodeXmlText(item.description).trim() : undefined;
      const desc = decodedDesc && decodedDesc.length > 0 ? decodedDesc.slice(0, 4000) : undefined;
      const candidate = {
        id,
        ats: "teamtailor",
        tenant_slug: opts.tenant.slug,
        source_id: sourceId,
        title: item.title,
        company,
        ...(desc ? { description_excerpt: desc } : {}),
        level: null,
        level_rank: null,
        workplace_type: workplaceFrom(item.remoteStatus),
        is_recruiter_post: false,
        ...(loc?.["tt:name"] ? { location_text: loc["tt:name"] } : {}),
        ...(loc?.["tt:city"] ? { location_region: loc["tt:city"] } : {}),
        ...(item["tt:department"] ? { department: item["tt:department"] } : {}),
        ...(postedAt ? { posted_at: postedAt } : {}),
        first_seen_at: opts.observedAt,
        last_seen_at: opts.observedAt,
        url: item.link,
      };
      const validated = JobSchema.safeParse(candidate);
      if (validated.success) jobs.push(validated.data);
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
