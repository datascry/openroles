import { type Job, JobSchema, type TenantInput, type TenantResult } from "@openroles/shared";
import { buildJob } from "../build-job.ts";
import type { HttpClient } from "../http.ts";
import { assertSafeSlug, dedupeById, errorToResult, vendorDateToIsoZ } from "./common.ts";

// UKG Pro / "Ultipro" exposes a public job-board search at
// `POST https://recruiting.ultipro.com/{TENANT}/JobBoard/{GUID}/JobBoardView/LoadSearchResults`.
// The `{GUID}` is the per-tenant board identifier captured at harvest time
// (`tenant.metadata.board_id`); without it we can't compose a working URL.
// The endpoint requires a JSON body with a `opportunitySearch` envelope —
// an empty `{}` body returns `{opportunities: [], totalCount: null}` for
// most tenants regardless of activity, which is why the harvest probe uses
// the empty body (cheaper) but the scraper sends the real search shape.

interface UltiproAddress {
  City?: string;
  PostalCode?: string;
  State?: { Code?: string; Name?: string };
  Country?: { Code?: string; Name?: string };
}

interface UltiproLocation {
  LocalizedName?: string;
  LocalizedDescription?: string;
  Address?: UltiproAddress;
}

interface UltiproOpportunity {
  Id?: string;
  Title?: string;
  RequisitionNumber?: string;
  FullTime?: boolean;
  JobCategoryName?: string;
  JobLocationType?: string;
  BriefDescription?: string;
  PostedDate?: string;
  Locations?: ReadonlyArray<UltiproLocation>;
}

interface UltiproResponse {
  opportunities?: ReadonlyArray<UltiproOpportunity>;
  totalCount?: number | null;
}

const SEARCH_BODY = JSON.stringify({
  opportunitySearch: {
    Top: 200,
    Skip: 0,
    QueryString: "",
    OrderBy: [{ Value: "postedDateDesc" }],
    Filters: [],
  },
});

const ISO3_TO_ISO2: Record<string, string> = {
  USA: "US",
  CAN: "CA",
  GBR: "GB",
  DEU: "DE",
  FRA: "FR",
  ESP: "ES",
  ITA: "IT",
  IRL: "IE",
  AUS: "AU",
  NZL: "NZ",
  IND: "IN",
  JPN: "JP",
  CHN: "CN",
  MEX: "MX",
  BRA: "BR",
  ARG: "AR",
  NLD: "NL",
  BEL: "BE",
  CHE: "CH",
  AUT: "AT",
  SWE: "SE",
  NOR: "NO",
  DNK: "DK",
  FIN: "FI",
  POL: "PL",
  PRT: "PT",
};

function locationCountry(addr: UltiproAddress | undefined): string | undefined {
  const code = addr?.Country?.Code;
  if (typeof code !== "string") return undefined;
  if (/^[A-Z]{2}$/.test(code)) return code;
  if (ISO3_TO_ISO2[code]) return ISO3_TO_ISO2[code];
  return undefined;
}

function locationText(loc: UltiproLocation | undefined): string | undefined {
  if (!loc) return undefined;
  const city = loc.Address?.City;
  const state = loc.Address?.State?.Name ?? loc.Address?.State?.Code;
  const country = loc.Address?.Country?.Name;
  const parts = [city, state, country].filter(
    (s): s is string => typeof s === "string" && s.length > 0,
  );
  if (parts.length > 0) return parts.join(", ");
  return loc.LocalizedName;
}

function workplaceFromType(value: unknown): Job["workplace_type"] {
  if (typeof value !== "string") return null;
  switch (value.toLowerCase()) {
    case "remote":
    case "remoteonly":
      return "remote";
    case "hybrid":
      return "hybrid";
    case "onsite":
    case "office":
      return "onsite";
    default:
      return null;
  }
}

export interface ScrapeUltiproOptions {
  readonly tenant: TenantInput;
  readonly client: HttpClient;
  readonly observedAt: string;
}

export interface ScrapeUltiproOutcome {
  readonly jobs: ReadonlyArray<Job>;
  readonly result: TenantResult;
}

export async function scrapeUltiproTenant(
  opts: ScrapeUltiproOptions,
): Promise<ScrapeUltiproOutcome> {
  try {
    assertSafeSlug(opts.tenant.slug);
    const boardId = opts.tenant.metadata?.["board_id"];
    if (typeof boardId !== "string" || !/^[0-9a-f-]{32,40}$/i.test(boardId)) {
      return {
        jobs: [],
        result: {
          slug: opts.tenant.slug,
          status: "dead",
          error: "ultipro tenant missing or invalid metadata.board_id",
          jobs_count: 0,
        },
      };
    }
    const tenantCode = opts.tenant.slug.toUpperCase();
    const url = `https://recruiting.ultipro.com/${tenantCode}/JobBoard/${boardId}/JobBoardView/LoadSearchResults`;
    const res = await opts.client.request(url, {
      method: "POST",
      body: SEARCH_BODY,
      headers: { "content-type": "application/json", accept: "application/json" },
      // recruiting.ultipro.com publishes a generic robots.txt; the
      // JobBoard endpoint is the documented public read-only surface.
      skipRobots: true,
    });
    const body = (await res.json()) as UltiproResponse;
    const items = body.opportunities ?? [];
    const company = opts.tenant.display_name ?? opts.tenant.slug;
    const jobs: Job[] = [];
    for (const item of items) {
      if (!item.Id || !item.Title) continue;
      const sourceId = item.RequisitionNumber || item.Id;
      // The UI links each opportunity at
      // `recruiting.ultipro.com/{TENANT}/JobBoard/{GUID}/OpportunityDetail?opportunityId={Id}`.
      const jobUrl = `https://recruiting.ultipro.com/${tenantCode}/JobBoard/${boardId}/OpportunityDetail?opportunityId=${item.Id}`;
      const firstLoc = item.Locations?.[0];
      const candidate = buildJob({
        ats: "ultipro",
        tenant_slug: opts.tenant.slug,
        company,
        source_id: sourceId,
        title: item.Title,
        url: jobUrl,
        ...(item.BriefDescription ? { description_html: item.BriefDescription } : {}),
        ...(locationText(firstLoc) ? { location_text: locationText(firstLoc) ?? "" } : {}),
        workplace_hint: item.JobLocationType ?? "",
        ...(item.JobCategoryName ? { department: item.JobCategoryName } : {}),
        ...(vendorDateToIsoZ(item.PostedDate) !== undefined
          ? { posted_at: vendorDateToIsoZ(item.PostedDate) ?? "" }
          : {}),
        is_recruiter_post: false,
        first_seen_at: opts.observedAt,
        last_seen_at: opts.observedAt,
      });
      const country = locationCountry(firstLoc?.Address);
      const region = firstLoc?.Address?.State?.Code;
      const enriched: Job = {
        ...candidate,
        workplace_type: workplaceFromType(item.JobLocationType) ?? candidate.workplace_type,
        ...(country ? { location_country: country } : {}),
        ...(region && /^[A-Z0-9]{2,3}$/.test(region) ? { location_region: region } : {}),
      };
      const validated = JobSchema.safeParse(enriched);
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
