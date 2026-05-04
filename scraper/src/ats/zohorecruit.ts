import { type Job, JobSchema, jobId, type TenantInput, type TenantResult } from "@openroles/shared";
import { XMLParser } from "fast-xml-parser";
import type { HttpClient } from "../http.ts";
import { decodeHtmlEntities, plainText } from "../normalize.ts";
import { assertSafeSlug, dedupeById, errorToResult, isRecruiterTitle } from "./common.ts";

// Zoho Recruit publishes a public RSS 2.0 feed at
// `https://{slug}.zohorecruit.com/jobs/Careers/rss` for every tenant whose
// careers page is set to public. Each `<item>` carries the canonical fields:
// title (CDATA-wrapped), link (deep-link to job detail), guid (Zoho's
// numeric job-opening id, used as `source_id`), pubDate, and a description
// CDATA block that begins with two structured prefix lines —
// `Category: X <br><br>Location: Y <br><br>` — followed by the HTML body.
//
// The endpoint returns HTTP 200 in three meaningfully-different shapes:
//   1. Real RSS XML (`<?xml ... ?><rss ...><channel>...</channel></rss>`).
//   2. The 49-byte text body
//      `Oops! It seems that the joblist has been removed.` —
//      a tenant whose careers page exists but has been emptied by the admin.
//   3. A ~2.6 KB HTML "page does not exist" body for tenants whose
//      subdomain has been deprovisioned.
// We classify (1) as success, (2) as success-with-zero (the tenant is alive
// and may publish again), and (3) as dead.

interface ZohoItem {
  title?: string | { "#text"?: string };
  link?: string | { "#text"?: string };
  guid?: string | number | { "#text"?: string | number };
  description?: string | { "#text"?: string };
  pubDate?: string;
}

interface ZohoFeed {
  rss?: {
    channel?: {
      title?: string | { "#text"?: string };
      item?: ZohoItem | ZohoItem[];
    };
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

function unwrapId(value: ZohoItem["guid"]): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value.trim().length > 0 ? value.trim() : undefined;
  if (typeof value === "number") return String(value);
  // fast-xml-parser yields `{ "#text": "...", "@_isPermaLink": "false" }` for
  // `<guid isPermaLink='false'>123</guid>` — extract the inner text. Numeric
  // ids (Zoho's are 18 digits) may have already been coerced to a JS number
  // by the parser, so guard for both shapes.
  const t = value["#text"];
  if (typeof t === "string") return t.trim().length > 0 ? t.trim() : undefined;
  if (typeof t === "number") return String(t);
  return undefined;
}

// Zoho's description CDATA opens with structured "Category: ..." and
// "Location: ..." lines that the rendering JS reads to populate the SPA's
// filter sidebar. They're far more reliable than parsing free-form prose
// inside the body, so we extract them verbatim and strip them off before
// computing the human-facing description excerpt.
const PREFIX_LINE_RE = /^([A-Z][A-Za-z ]{1,32}):\s*([^<\n]*?)\s*(?:<br\s*\/?\s*>|\n|$)/i;

interface ParsedDescription {
  readonly category?: string;
  readonly location?: string;
  readonly excerpt?: string;
}

function parseDescription(raw: string): ParsedDescription {
  const decoded = decodeHtmlEntities(raw);
  let cursor = decoded;
  let category: string | undefined;
  let locationText: string | undefined;
  for (let i = 0; i < 6; i += 1) {
    const trimmed = cursor.replace(/^(?:<br\s*\/?\s*>|\s)+/i, "");
    const match = trimmed.match(PREFIX_LINE_RE);
    if (!match) {
      cursor = trimmed;
      break;
    }
    const key = match[1]?.toLowerCase().trim();
    const value = match[2]?.trim();
    if (value !== undefined && value.length > 0) {
      if (key === "category" && category === undefined) category = value;
      else if (key === "location" && locationText === undefined) locationText = value;
    }
    cursor = trimmed.slice(match[0].length);
  }
  const body = plainText(cursor);
  const excerpt = body.length > 0 ? body.slice(0, 4000) : undefined;
  const out: ParsedDescription = {};
  if (category !== undefined) (out as { category?: string }).category = category;
  if (locationText !== undefined) (out as { location?: string }).location = locationText;
  if (excerpt !== undefined) (out as { excerpt?: string }).excerpt = excerpt;
  return out;
}

// Zoho pubDate is formatted in the tenant's locale — English ("Wed, 22 Apr
// 2026 12:00:00 PDT") parses cleanly; French/Portuguese ("mer., 09 juil.
// 2025 09:32:52 PDT") does not. Fall back to undefined when `Date` rejects
// the input rather than leaking NaN through to the schema.
function pubDateToIso(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toISOString();
}

// Zoho doesn't expose remote/hybrid as a discrete field — the location string
// is the only signal. "Remote" appears verbatim for tenants that publish
// fully-remote roles; otherwise default to null and let the renderer show
// "unspecified" rather than guessing onsite.
function workplaceFromLocation(location: string | undefined): Job["workplace_type"] {
  if (!location) return null;
  const lower = location.toLowerCase();
  if (lower.includes("remote")) return "remote";
  if (lower.includes("hybrid")) return "hybrid";
  return null;
}

// The 49-byte body Zoho returns when a tenant has set the joblist to
// private or removed every opening. We treat this as success-with-zero
// (tenant is alive, will likely publish again) rather than dead.
const JOBLIST_REMOVED = "Oops! It seems that the joblist has been removed.";

// The error HTML returned for subdomains that don't exist or have been
// deprovisioned. Both variants ("Page does not exist" full-page error and
// "page you're trying to access could not be found" smaller variant)
// share these signature strings.
const DEAD_TENANT_MARKERS = ["does not exist.", "could not be found", "Page does not exist"];

function isDeadTenantBody(body: string): boolean {
  if (!body.startsWith("<!DOCTYPE") && !body.startsWith("<html")) return false;
  return DEAD_TENANT_MARKERS.some((marker) => body.includes(marker));
}

export interface ScrapeZohorecruitOptions {
  readonly tenant: TenantInput;
  readonly client: HttpClient;
  readonly observedAt: string;
}

export interface ScrapeZohorecruitOutcome {
  readonly jobs: ReadonlyArray<Job>;
  readonly result: TenantResult;
}

type Outcome = ScrapeZohorecruitOutcome;

function emptyOutcome(
  slug: string,
  status: TenantResult["status"],
  httpStatus: number,
  error?: string,
): Outcome {
  return {
    jobs: [],
    result: {
      slug,
      status,
      http_status: httpStatus,
      ...(error !== undefined ? { error } : {}),
      jobs_count: 0,
    },
  };
}

// Discriminate the three known shapes Zoho returns. The 200-status responses
// are not unique by HTTP code — only by body content.
type BodyKind =
  | { kind: "joblist_removed" }
  | { kind: "dead" }
  | { kind: "non_xml" }
  | { kind: "xml" };

function classifyBody(trimmed: string): BodyKind {
  if (trimmed === JOBLIST_REMOVED || trimmed.startsWith("Oops!")) {
    return { kind: "joblist_removed" };
  }
  if (isDeadTenantBody(trimmed)) return { kind: "dead" };
  if (!trimmed.startsWith("<?xml") && !trimmed.startsWith("<rss")) {
    return { kind: "non_xml" };
  }
  return { kind: "xml" };
}

function deriveCompany(channelTitleRaw: string | undefined, tenant: TenantInput): string {
  // Channel title is "Acme Corp - Careers" — drop the suffix when present
  // so the rendered company doesn't read "Acme Corp - Careers Engineer".
  const cleaned = channelTitleRaw ? channelTitleRaw.replace(/\s*-\s*Careers\s*$/i, "").trim() : "";
  if (cleaned.length > 0) return cleaned;
  if (tenant.display_name && tenant.display_name.length > 0) return tenant.display_name;
  return tenant.slug;
}

function buildJob(
  item: ZohoItem,
  ctx: { tenant: TenantInput; company: string; observedAt: string },
): Job | undefined {
  const sourceId = unwrapId(item.guid);
  const title = unwrapText(item.title);
  const link = unwrapText(item.link);
  if (!sourceId || !title || !link) return undefined;
  const id = jobId({
    ats: "zohorecruit",
    tenant_slug: ctx.tenant.slug,
    source_id: sourceId,
    url: link,
  });
  const descRaw = unwrapText(item.description);
  const parsedDesc: ParsedDescription = descRaw ? parseDescription(descRaw) : {};
  const postedAt = pubDateToIso(item.pubDate);
  // The schema rejects posted_at > last_seen_at. A future-dated pubDate
  // (rare, but possible from clock skew or a tenant's local clock running
  // ahead) would otherwise fail the entire entry — drop the field instead
  // of the whole job.
  const safePostedAt = postedAt !== undefined && postedAt > ctx.observedAt ? undefined : postedAt;
  const candidate: Job = {
    id,
    ats: "zohorecruit",
    tenant_slug: ctx.tenant.slug,
    source_id: sourceId,
    title,
    company: ctx.company,
    ...(parsedDesc.excerpt ? { description_excerpt: parsedDesc.excerpt } : {}),
    level: null,
    level_rank: null,
    workplace_type: workplaceFromLocation(parsedDesc.location),
    is_recruiter_post: isRecruiterTitle(title),
    ...(parsedDesc.location ? { location_text: parsedDesc.location } : {}),
    ...(parsedDesc.category ? { department: parsedDesc.category } : {}),
    ...(safePostedAt ? { posted_at: safePostedAt } : {}),
    first_seen_at: ctx.observedAt,
    last_seen_at: ctx.observedAt,
    is_stale: false,
    url: link,
  };
  const validated = JobSchema.safeParse(candidate);
  return validated.success ? validated.data : undefined;
}

function scrapeChannel(
  channel: NonNullable<NonNullable<ZohoFeed["rss"]>["channel"]>,
  opts: ScrapeZohorecruitOptions,
  httpStatus: number,
): Outcome {
  const company = deriveCompany(unwrapText(channel.title), opts.tenant);
  const raw = channel.item;
  const items: ZohoItem[] = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const jobs: Job[] = [];
  let parseFailed = 0;
  for (const item of items) {
    const job = buildJob(item, { tenant: opts.tenant, company, observedAt: opts.observedAt });
    if (job) jobs.push(job);
    else parseFailed += 1;
  }
  // Mirror the homerun / talentlyft / jobvite policy: when the channel
  // contained items but more than half of them failed to parse, this is
  // most likely a vendor schema drift rather than a real success — surface
  // it as transient_failure so the next harvest retries.
  if (items.length > 0 && parseFailed > items.length * 0.5) {
    return emptyOutcome(
      opts.tenant.slug,
      "transient_failure",
      httpStatus,
      `${parseFailed} of ${items.length} feed items failed to parse`,
    );
  }
  return {
    jobs: dedupeById(jobs),
    result: {
      slug: opts.tenant.slug,
      status: "success",
      http_status: httpStatus,
      jobs_count: jobs.length,
    },
  };
}

export async function scrapeZohorecruitTenant(
  opts: ScrapeZohorecruitOptions,
): Promise<ScrapeZohorecruitOutcome> {
  try {
    assertSafeSlug(opts.tenant.slug);
    const url = `https://${opts.tenant.slug}.zohorecruit.com/jobs/Careers/rss`;
    const res = await opts.client.request(url);
    const body = await res.text();
    const trimmed = body.trim();
    const classified = classifyBody(trimmed);
    if (classified.kind === "joblist_removed") {
      return emptyOutcome(opts.tenant.slug, "success", res.status);
    }
    if (classified.kind === "dead") {
      return emptyOutcome(
        opts.tenant.slug,
        "dead",
        res.status,
        "tenant subdomain returns Zoho 'does not exist' page",
      );
    }
    if (classified.kind === "non_xml") {
      return emptyOutcome(
        opts.tenant.slug,
        "transient_failure",
        res.status,
        "response body is not RSS XML",
      );
    }
    const parsed = xmlParser.parse(body) as ZohoFeed;
    const channel = parsed.rss?.channel;
    if (!channel) {
      return emptyOutcome(
        opts.tenant.slug,
        "transient_failure",
        res.status,
        "RSS missing <channel> element",
      );
    }
    return scrapeChannel(channel, opts, res.status);
  } catch (err) {
    return { jobs: [], result: errorToResult(opts.tenant.slug, err) };
  }
}
