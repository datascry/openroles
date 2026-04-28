import { type Job, JobSchema, jobId, type TenantInput, type TenantResult } from "@openroles/shared";
import { XMLParser } from "fast-xml-parser";
import type { HttpClient } from "../http.ts";
import { assertSafeSlug, dedupeById, errorToResult } from "./common.ts";

// Homerun publishes a public Atom feed at `https://feed.homerun.co/{slug}` for
// every tenant that has a careers page. The feed entries carry structured
// fields (department, location, type, updated) — much cleaner than parsing
// the JS-rendered tenant landing page.

interface HomerunNamed {
  name?: string;
}

interface HomerunLink {
  "@_href"?: string;
  "@_rel"?: string;
  "@_type"?: string;
}

interface HomerunEntry {
  title?: string | { "#text"?: string };
  link?: HomerunLink | HomerunLink[];
  id?: string;
  summary?: string | { "#text"?: string };
  description?: string | { "#text"?: string };
  content?: string | { "#text"?: string };
  author?: HomerunNamed;
  department?: HomerunNamed;
  location?: HomerunNamed;
  type?: HomerunNamed;
  updated?: string;
  salary_indication?: string;
}

interface HomerunFeed {
  feed?: {
    title?: string | { "#text"?: string };
    entry?: HomerunEntry | HomerunEntry[];
  };
}

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  trimValues: true,
});

function unwrapText(value: string | { "#text"?: string } | undefined): string | undefined {
  if (typeof value === "string") return value.length > 0 ? value : undefined;
  const t = value?.["#text"];
  return typeof t === "string" && t.length > 0 ? t : undefined;
}

function entryAlternateLink(link: HomerunEntry["link"]): string | undefined {
  if (!link) return undefined;
  const list = Array.isArray(link) ? link : [link];
  // The feed lists multiple <link> elements; the alternate-relation one
  // points at the public job detail page on `{slug}.homerun.co`.
  const alt = list.find((l) => (l["@_rel"] ?? "alternate") === "alternate" && l["@_href"]);
  return alt?.["@_href"];
}

function workplaceFromType(value: string | undefined): Job["workplace_type"] {
  switch (value?.toLowerCase()) {
    case "remote":
      return "remote";
    case "hybrid":
      return "hybrid";
    default:
      return null;
  }
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function isoOrUndefined(value: string | undefined): string | undefined {
  if (!value) return undefined;
  // Homerun's <updated> ranges from RFC-3339 (`2026-04-24T07:42:51+00:00`) to
  // a space-separated naive timestamp (`2026-04-13 08:46:19`); both round-trip
  // through `new Date(...).toISOString()`.
  const d = new Date(value.includes("T") ? value : value.replace(" ", "T"));
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

export interface ScrapeHomerunOptions {
  readonly tenant: TenantInput;
  readonly client: HttpClient;
  readonly observedAt: string;
}

export interface ScrapeHomerunOutcome {
  readonly jobs: ReadonlyArray<Job>;
  readonly result: TenantResult;
}

export async function scrapeHomerunTenant(
  opts: ScrapeHomerunOptions,
): Promise<ScrapeHomerunOutcome> {
  try {
    assertSafeSlug(opts.tenant.slug);
    const url = `https://feed.homerun.co/${opts.tenant.slug}`;
    const res = await opts.client.request(url);
    const xml = await res.text();
    const parsed = xmlParser.parse(xml) as HomerunFeed;
    const feed = parsed.feed;
    const channelTitle = unwrapText(feed?.title);
    const company = channelTitle ?? opts.tenant.display_name ?? opts.tenant.slug;
    const raw = feed?.entry;
    const entries: HomerunEntry[] = Array.isArray(raw) ? raw : raw ? [raw] : [];
    const jobs: Job[] = [];
    for (const item of entries) {
      const sourceId = item.id;
      const title = unwrapText(item.title);
      const link = entryAlternateLink(item.link);
      if (!sourceId || !title || !link) continue;
      const id = jobId({
        ats: "homerun",
        tenant_slug: opts.tenant.slug,
        source_id: sourceId,
        url: link,
      });
      const description = unwrapText(item.description) ?? unwrapText(item.content);
      const decoded = description ? decodeXmlEntities(description).trim() : undefined;
      const desc = decoded && decoded.length > 0 ? decoded.slice(0, 4000) : undefined;
      const updatedAt = isoOrUndefined(item.updated);
      const author = item.author?.name;
      const candidate = {
        id,
        ats: "homerun",
        tenant_slug: opts.tenant.slug,
        source_id: sourceId,
        title,
        company: author ?? company,
        ...(desc ? { description_excerpt: desc } : {}),
        level: null,
        level_rank: null,
        workplace_type: workplaceFromType(item.location?.name),
        is_recruiter_post: false,
        ...(item.location?.name ? { location_text: item.location.name } : {}),
        ...(item.department?.name ? { department: item.department.name } : {}),
        ...(updatedAt ? { updated_at: updatedAt } : {}),
        first_seen_at: opts.observedAt,
        last_seen_at: opts.observedAt,
        url: link,
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
