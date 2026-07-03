import { type Job, JobSchema, jobId, type TenantInput, type TenantResult } from "@openroles/shared";
import pLimit from "p-limit";
import type { HttpClient } from "../http.ts";
import { excerpt, normalizeWorkplace, plainText, splitLocation } from "../normalize.ts";
import { assertSafeSlug, dedupeById, errorToResult, isRecruiterTitle } from "./common.ts";

// One row of the list resource `/platform/api/ats/v1/board/{slug}/jobs`,
// which returns a top-level array of every open role in a single
// unpaginated call. The list carries identity + routing fields only
// (uuid, title, department, single workLocation, canonical url) — the
// post date and description live on the per-job detail resource.
interface RipplingListItem {
  uuid?: string | null;
  name?: string | null;
  url?: string | null;
  department?: { id?: string | null; label?: string | null } | null;
  workLocation?: { id?: string | null; label?: string | null } | null;
}

// The detail resource `/platform/api/ats/v1/board/{slug}/jobs/{uuid}`.
// `description` is an object of HTML fragments ({ company, role }); the
// role fragment is the posting body. `createdOn` is an ISO timestamp with
// a timezone offset. `payRangeDetails` is an array of per-location ranges.
interface RipplingPayRange {
  currency?: string | null;
  frequency?: string | null;
  rangeStart?: number | null;
  rangeEnd?: number | null;
}

export interface RipplingDetail {
  uuid?: string | null;
  name?: string | null;
  description?: { company?: string | null; role?: string | null } | null;
  workLocations?: ReadonlyArray<string> | null;
  companyName?: string | null;
  createdOn?: string | null;
  payRangeDetails?: ReadonlyArray<RipplingPayRange> | null;
}

// Per-tenant detail fan-out bounds. Rippling boards observed in the wild
// carry single- to low-double-digit role counts; the cap is a safety
// backstop against a pathological board, and the concurrency limit keeps
// the fan-out gentle on the shared `api.rippling.com` backend every tenant
// resolves to. A tenant whose board exceeds the cap is reported with an
// explicit "capped" note rather than silently truncated.
const MAX_DETAIL_FETCH_PER_TENANT = 500;
const DEFAULT_PER_TENANT_CONCURRENCY = 6;

const LIST_API = "https://api.rippling.com/platform/api/ats/v1/board";

function trimmedOrUndefined(raw: string | null | undefined): string | undefined {
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : undefined;
}

// Only trust a record's own `url` when it is a well-formed https link on the
// hosted board host; anything else (scheme downgrade, off-host, malformed)
// falls back to the composed canonical URL. The public job page answers at
// `ats.rippling.com/{slug}/jobs/{uuid}` — the exact shape the API emits.
export function ripplingJobUrl(slug: string, uuid: string, raw: string | null | undefined): string {
  if (typeof raw === "string") {
    try {
      const parsed = new URL(raw);
      if (
        parsed.protocol === "https:" &&
        parsed.username === "" &&
        parsed.password === "" &&
        parsed.hostname === "ats.rippling.com"
      ) {
        return parsed.toString();
      }
    } catch {
      // fall through to the composed URL
    }
  }
  return `https://ats.rippling.com/${slug}/jobs/${encodeURIComponent(uuid)}`;
}

// `createdOn` carries a timezone offset (`…-07:00`); Date normalises it to
// UTC. Drop any value that would violate the schema's posted_at <=
// last_seen_at rule (clock skew, scheduled postings) rather than letting
// safeParse reject the whole row.
function ripplingPostedAt(raw: string | null | undefined, observedAt: string): string | undefined {
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return undefined;
  const posted = d.toISOString();
  return posted <= observedAt ? posted : undefined;
}

// The role fragment of `description` is HTML with inline styles and may
// carry raw newlines; plainText strips tags, decodes entities and collapses
// whitespace — without it the control characters would fail JobSchema's
// excerpt validation and drop the row.
function ripplingDescription(description: RipplingDetail["description"]): string | undefined {
  const role = trimmedOrUndefined(description?.role);
  if (role === undefined) return undefined;
  const text = plainText(role);
  return text.length > 0 ? excerpt(text) : undefined;
}

// Location text: the detail's `workLocations` (first entry) when present,
// else the list's single `workLocation.label`. Both are free-form
// "City, ST" / "City, Country" strings the board renders verbatim.
function ripplingLocationText(
  detail: RipplingDetail | undefined,
  listItem: RipplingListItem,
): string | undefined {
  const fromDetail = detail?.workLocations?.find((l) => trimmedOrUndefined(l) !== undefined);
  return trimmedOrUndefined(fromDetail) ?? trimmedOrUndefined(listItem.workLocation?.label);
}

// First pay range whose bounds are positive integers. A range with only one
// bound is kept; an inverted range is vendor noise and dropped entirely.
function ripplingCompensation(ranges: RipplingDetail["payRangeDetails"]): {
  min?: number;
  max?: number;
  currency?: string;
} {
  const range = ranges?.[0];
  if (!range) return {};
  const min = money(range.rangeStart);
  const max = money(range.rangeEnd);
  if (min !== undefined && max !== undefined && min > max) return {};
  if (min === undefined && max === undefined) return {};
  const currency = trimmedOrUndefined(range.currency);
  return {
    ...(min !== undefined ? { min } : {}),
    ...(max !== undefined ? { max } : {}),
    ...(currency !== undefined ? { currency } : {}),
  };
}

function money(raw: number | null | undefined): number | undefined {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return undefined;
  return Math.round(raw);
}

// Build a Job from a list entry merged with its (optional) detail record.
// Returns null when the row lacks a usable uuid/title or fails schema
// validation. Pure — no HTTP — so it can be fixture-replayed and
// property-tested deterministically.
function buildRipplingJob(
  tenantSlug: string,
  fallbackCompany: string,
  observedAt: string,
  listItem: RipplingListItem,
  detail: RipplingDetail | undefined,
): Job | null {
  const uuid = trimmedOrUndefined(listItem.uuid);
  if (uuid === undefined) return null;
  // Titles occasionally carry HTML entities; plainText decodes and collapses.
  const rawTitle = trimmedOrUndefined(listItem.name) ?? trimmedOrUndefined(detail?.name);
  const title = rawTitle ? trimmedOrUndefined(plainText(rawTitle)) : undefined;
  if (title === undefined) return null;

  const url = ripplingJobUrl(tenantSlug, uuid, listItem.url);
  const id = jobId({ ats: "rippling", tenant_slug: tenantSlug, source_id: uuid, url });

  const company = trimmedOrUndefined(detail?.companyName) ?? fallbackCompany;
  const locationText = ripplingLocationText(detail, listItem);
  const region = locationText ? splitLocation(locationText).region : undefined;
  const country = locationText ? splitLocation(locationText).country : undefined;
  const department = trimmedOrUndefined(listItem.department?.label);
  const description = ripplingDescription(detail?.description);
  const postedAt = ripplingPostedAt(detail?.createdOn, observedAt);
  const comp = ripplingCompensation(detail?.payRangeDetails);

  const candidate = {
    id,
    ats: "rippling",
    tenant_slug: tenantSlug,
    source_id: uuid,
    title,
    company,
    level: null,
    level_rank: null,
    workplace_type: normalizeWorkplace(`${title} ${locationText ?? ""}`),
    is_recruiter_post: isRecruiterTitle(title),
    ...(description ? { description_excerpt: description } : {}),
    ...(locationText ? { location_text: locationText } : {}),
    ...(country ? { location_country: country } : {}),
    ...(region ? { location_region: region } : {}),
    ...(department ? { department } : {}),
    ...(postedAt ? { posted_at: postedAt } : {}),
    ...(comp.min !== undefined ? { compensation_min: comp.min } : {}),
    ...(comp.max !== undefined ? { compensation_max: comp.max } : {}),
    ...(comp.currency ? { compensation_currency: comp.currency } : {}),
    first_seen_at: observedAt,
    last_seen_at: observedAt,
    url,
  };
  const validated = JobSchema.safeParse(candidate);
  return validated.success ? validated.data : null;
}

export interface ParseRipplingListInput {
  readonly tenant: TenantInput;
  readonly company: string;
  readonly response: unknown;
  readonly observedAt: string;
  // Detail records keyed by uuid, when the N+1 fan-out has run. Absent
  // entries fall back to list-only fields (no date/description).
  readonly details?: ReadonlyMap<string, RipplingDetail>;
}

// Pure parser over the top-level list array, merged with any fetched detail
// records → validated Jobs, deduped by id.
export function parseRipplingJobs(input: ParseRipplingListInput): Job[] {
  const list = Array.isArray(input.response) ? (input.response as RipplingListItem[]) : [];
  const jobs: Job[] = [];
  for (const item of list) {
    const uuid = trimmedOrUndefined(item.uuid);
    const detail = uuid !== undefined ? input.details?.get(uuid) : undefined;
    const job = buildRipplingJob(input.tenant.slug, input.company, input.observedAt, item, detail);
    if (job) jobs.push(job);
  }
  return dedupeById(jobs);
}

export interface ScrapeRipplingOptions {
  readonly tenant: TenantInput;
  readonly client: HttpClient;
  readonly observedAt: string;
  readonly perTenantConcurrency?: number;
  // Detail fan-out ceiling. Defaults to MAX_DETAIL_FETCH_PER_TENANT; exposed
  // so the fan-out cap is exercisable without a 500-row fixture.
  readonly maxDetailFetch?: number;
}

export interface ScrapeRipplingOutcome {
  readonly jobs: ReadonlyArray<Job>;
  readonly result: TenantResult;
}

export async function scrapeRipplingTenant(
  opts: ScrapeRipplingOptions,
): Promise<ScrapeRipplingOutcome> {
  try {
    assertSafeSlug(opts.tenant.slug);
    const company = opts.tenant.display_name ?? opts.tenant.slug;

    const listRes = await opts.client.request(`${LIST_API}/${opts.tenant.slug}/jobs`);
    const httpStatus = listRes.status;
    const body = (await listRes.json()) as unknown;
    const list = Array.isArray(body) ? (body as RipplingListItem[]) : [];

    // Bounded N+1: fan out a detail GET per role to populate posted_at,
    // description and pay. Roles carrying a usable uuid beyond the cap are
    // still emitted from list-only fields; only their enrichment is skipped.
    const cap = opts.maxDetailFetch ?? MAX_DETAIL_FETCH_PER_TENANT;
    const withUuid = list.filter((i) => trimmedOrUndefined(i.uuid) !== undefined);
    const toFetch = withUuid.slice(0, cap);
    const capped = withUuid.length > cap;

    const details = new Map<string, RipplingDetail>();
    const limit = pLimit(opts.perTenantConcurrency ?? DEFAULT_PER_TENANT_CONCURRENCY);
    await Promise.all(
      toFetch.map((item) =>
        limit(async () => {
          const uuid = trimmedOrUndefined(item.uuid);
          if (uuid === undefined) return;
          try {
            const res = await opts.client.request(
              `${LIST_API}/${opts.tenant.slug}/jobs/${encodeURIComponent(uuid)}`,
            );
            const detail = (await res.json()) as RipplingDetail;
            if (detail && typeof detail === "object") details.set(uuid, detail);
          } catch {
            // Detail is enrichment only — a failed detail GET leaves the row
            // built from list-only fields rather than dropping it.
          }
        }),
      ),
    );

    const jobs = parseRipplingJobs({
      tenant: opts.tenant,
      company,
      response: body,
      observedAt: opts.observedAt,
      details,
    });

    return {
      jobs,
      result: {
        slug: opts.tenant.slug,
        status: "success",
        http_status: httpStatus,
        ...(capped ? { error: `capped at ${cap} of ${withUuid.length} roles` } : {}),
        jobs_count: jobs.length,
      },
    };
  } catch (err) {
    return { jobs: [], result: errorToResult(opts.tenant.slug, err) };
  }
}
