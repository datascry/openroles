import { type Job, jobId, type TenantInput, type TenantResult } from "@openroles/shared";
import type { HttpClient } from "../http.ts";
import { assertSafeSlug, dedupeById, errorToResult } from "./common.ts";

interface BreezyPosition {
  _id?: string;
  name?: string;
  location?: { name?: string; country?: { code?: string }; city?: { name?: string } } | string;
  type?: { name?: string };
  category?: { name?: string };
  description?: string;
  url?: string;
  apply_url?: string;
  published_date?: string;
  updated_date?: string;
  is_remote?: boolean;
}

interface BreezyResponse {
  company?: { name?: string };
  positions?: ReadonlyArray<BreezyPosition>;
}

function locationText(loc: BreezyPosition["location"]): string | undefined {
  if (!loc) return undefined;
  if (typeof loc === "string") return loc;
  if (loc.name) return loc.name;
  return undefined;
}

function locationCountry(loc: BreezyPosition["location"]): string | undefined {
  if (!loc || typeof loc === "string") return undefined;
  return loc.country?.code?.toUpperCase();
}

function locationCity(loc: BreezyPosition["location"]): string | undefined {
  if (!loc || typeof loc === "string") return undefined;
  return loc.city?.name;
}

function isoOrUndefined(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

export interface ScrapeBreezyOptions {
  readonly tenant: TenantInput;
  readonly client: HttpClient;
  readonly observedAt: string;
}

export interface ScrapeBreezyOutcome {
  readonly jobs: ReadonlyArray<Job>;
  readonly result: TenantResult;
}

export async function scrapeBreezyTenant(opts: ScrapeBreezyOptions): Promise<ScrapeBreezyOutcome> {
  try {
    assertSafeSlug(opts.tenant.slug);
    const url = `https://${opts.tenant.slug}.breezy.hr/json`;
    const res = await opts.client.request(url);
    const body = (await res.json()) as BreezyResponse;
    const company = body.company?.name ?? opts.tenant.display_name ?? opts.tenant.slug;
    const jobs: Job[] = [];
    for (const pos of body.positions ?? []) {
      if (!pos._id || !pos.name) continue;
      const sourceId = pos._id;
      const posUrl =
        pos.url ?? pos.apply_url ?? `https://${opts.tenant.slug}.breezy.hr/p/${sourceId}`;
      const id = jobId({
        ats: "breezy",
        tenant_slug: opts.tenant.slug,
        source_id: sourceId,
        url: posUrl,
      });
      const postedAt = isoOrUndefined(pos.published_date);
      const updatedAt = isoOrUndefined(pos.updated_date);
      const country = locationCountry(pos.location);
      const city = locationCity(pos.location);
      const locText = locationText(pos.location);
      jobs.push({
        id,
        ats: "breezy",
        tenant_slug: opts.tenant.slug,
        source_id: sourceId,
        title: pos.name,
        company,
        ...(pos.description ? { description_excerpt: pos.description.slice(0, 4000) } : {}),
        level: null,
        level_rank: null,
        workplace_type: pos.is_remote ? "remote" : null,
        is_recruiter_post: false,
        ...(locText ? { location_text: locText } : {}),
        ...(country ? { location_country: country } : {}),
        ...(city ? { location_region: city } : {}),
        ...(pos.category?.name ? { department: pos.category.name } : {}),
        ...(postedAt ? { posted_at: postedAt } : {}),
        ...(updatedAt ? { updated_at: updatedAt } : {}),
        first_seen_at: opts.observedAt,
        last_seen_at: opts.observedAt,
        url: posUrl,
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
