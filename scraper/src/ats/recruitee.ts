import { type Job, jobId, type TenantInput, type TenantResult } from "@openroles/shared";
import type { HttpClient } from "../http.ts";
import { assertSafeSlug, dedupeById, epochToIso, errorToResult } from "./common.ts";

interface RecruiteeOffer {
  id?: number;
  title?: string;
  location?: string;
  city?: string;
  country_code?: string;
  remote?: boolean;
  hybrid?: boolean;
  description?: string;
  careers_url?: string;
  url?: string;
  created_at?: string | number;
  updated_at?: string | number;
  department?: string;
}

interface RecruiteeResponse {
  offers?: ReadonlyArray<RecruiteeOffer>;
}

function workplaceFromOffer(o: RecruiteeOffer): Job["workplace_type"] {
  if (o.remote === true) return "remote";
  if (o.hybrid === true) return "hybrid";
  return null;
}

function parseTimestamp(value: string | number | undefined): string | undefined {
  if (typeof value === "number") return epochToIso(value < 1e12 ? value * 1000 : value);
  if (typeof value === "string" && value.length > 0) {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return undefined;
}

export interface ScrapeRecruiteeOptions {
  readonly tenant: TenantInput;
  readonly client: HttpClient;
  readonly observedAt: string;
}

export interface ScrapeRecruiteeOutcome {
  readonly jobs: ReadonlyArray<Job>;
  readonly result: TenantResult;
}

export async function scrapeRecruiteeTenant(
  opts: ScrapeRecruiteeOptions,
): Promise<ScrapeRecruiteeOutcome> {
  try {
    assertSafeSlug(opts.tenant.slug);
    const url = `https://${opts.tenant.slug}.recruitee.com/api/offers/`;
    const res = await opts.client.request(url);
    const body = (await res.json()) as RecruiteeResponse;
    const company = opts.tenant.display_name ?? opts.tenant.slug;
    const jobs: Job[] = [];
    for (const offer of body.offers ?? []) {
      if (offer.id === undefined || !offer.title) continue;
      const sourceId = String(offer.id);
      const offerUrl =
        offer.careers_url ?? offer.url ?? `https://${opts.tenant.slug}.recruitee.com/o/${sourceId}`;
      const id = jobId({
        ats: "recruitee",
        tenant_slug: opts.tenant.slug,
        source_id: sourceId,
        url: offerUrl,
      });
      const postedAt = parseTimestamp(offer.created_at);
      const updatedAt = parseTimestamp(offer.updated_at);
      jobs.push({
        id,
        ats: "recruitee",
        tenant_slug: opts.tenant.slug,
        source_id: sourceId,
        title: offer.title,
        company,
        ...(offer.description ? { description_excerpt: offer.description.slice(0, 4000) } : {}),
        level: null,
        level_rank: null,
        workplace_type: workplaceFromOffer(offer),
        is_recruiter_post: false,
        ...(offer.location ? { location_text: offer.location } : {}),
        ...(offer.country_code ? { location_country: offer.country_code.toUpperCase() } : {}),
        ...(offer.city ? { location_region: offer.city } : {}),
        ...(offer.department ? { department: offer.department } : {}),
        ...(postedAt ? { posted_at: postedAt } : {}),
        ...(updatedAt ? { updated_at: updatedAt } : {}),
        first_seen_at: opts.observedAt,
        last_seen_at: opts.observedAt,
        url: offerUrl,
      });
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
