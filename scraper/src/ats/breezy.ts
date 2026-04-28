import { type Job, JobSchema, jobId, type TenantInput, type TenantResult } from "@openroles/shared";
import type { HttpClient } from "../http.ts";
import { assertSafeSlug, dedupeById, errorToResult } from "./common.ts";

// Breezy's `/json` endpoint can return either a `{ company, positions }`
// envelope (older shape) or a flat array of positions at the top level
// (current public widget shape). Both are accepted; identifier and location
// fields use whichever names are present.
interface BreezyLocationObject {
  name?: string;
  country?: { code?: string; id?: string; name?: string };
  state?: { id?: string; name?: string };
  // `city` is a string in the widget shape, an object in older shapes.
  city?: string | { name?: string };
  is_remote?: boolean;
}

interface BreezyPosition {
  // older shape used `_id`; widget shape uses `id`.
  _id?: string;
  id?: string;
  name?: string;
  location?: BreezyLocationObject | string;
  type?: { name?: string };
  category?: { name?: string };
  department?: { name?: string } | string | null;
  description?: string;
  url?: string;
  apply_url?: string;
  published_date?: string;
  updated_date?: string;
  is_remote?: boolean;
  company?: { name?: string };
}

interface BreezyEnvelope {
  company?: { name?: string };
  positions?: ReadonlyArray<BreezyPosition>;
}

function locationText(loc: BreezyPosition["location"]): string | undefined {
  if (!loc) return undefined;
  if (typeof loc === "string") return loc;
  if (loc.name) return loc.name;
  const cityStr = typeof loc.city === "string" ? loc.city : loc.city?.name;
  const stateName = loc.state?.name;
  const countryName = loc.country?.name;
  const parts = [cityStr, stateName, countryName].filter(
    (s): s is string => typeof s === "string" && s.length > 0,
  );
  return parts.length > 0 ? parts.join(", ") : undefined;
}

function locationCountry(loc: BreezyPosition["location"]): string | undefined {
  if (!loc || typeof loc === "string") return undefined;
  const code = loc.country?.code ?? loc.country?.id;
  if (typeof code === "string" && /^[A-Za-z]{2}$/.test(code)) return code.toUpperCase();
  return undefined;
}

function locationCity(loc: BreezyPosition["location"]): string | undefined {
  if (!loc || typeof loc === "string") return undefined;
  if (typeof loc.city === "string") return loc.city;
  return loc.city?.name;
}

function isPositionRemote(loc: BreezyPosition["location"], pos: BreezyPosition): boolean {
  if (pos.is_remote === true) return true;
  if (loc && typeof loc !== "string" && loc.is_remote === true) return true;
  return false;
}

function departmentName(value: BreezyPosition["department"]): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") return value.length > 0 ? value : undefined;
  return value.name;
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
    const body = (await res.json()) as BreezyEnvelope | ReadonlyArray<BreezyPosition>;
    const isArray = Array.isArray(body);
    const positions: ReadonlyArray<BreezyPosition> = isArray
      ? (body as ReadonlyArray<BreezyPosition>)
      : ((body as BreezyEnvelope).positions ?? []);
    const envelopeCompany = isArray ? undefined : (body as BreezyEnvelope).company?.name;
    const fallbackCompany = opts.tenant.display_name ?? opts.tenant.slug;
    const jobs: Job[] = [];
    for (const pos of positions) {
      const sourceId = pos.id ?? pos._id;
      if (!sourceId || !pos.name) continue;
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
      const remote = isPositionRemote(pos.location, pos);
      const trimmedDesc = pos.description?.trim();
      const company = pos.company?.name ?? envelopeCompany ?? fallbackCompany;
      const dept = departmentName(pos.department) ?? pos.category?.name;
      const candidate = {
        id,
        ats: "breezy",
        tenant_slug: opts.tenant.slug,
        source_id: sourceId,
        title: pos.name,
        company,
        ...(trimmedDesc ? { description_excerpt: trimmedDesc.slice(0, 4000) } : {}),
        level: null,
        level_rank: null,
        workplace_type: remote ? "remote" : null,
        is_recruiter_post: false,
        ...(locText ? { location_text: locText } : {}),
        ...(country ? { location_country: country } : {}),
        ...(city ? { location_region: city } : {}),
        ...(dept ? { department: dept } : {}),
        ...(postedAt ? { posted_at: postedAt } : {}),
        ...(updatedAt ? { updated_at: updatedAt } : {}),
        first_seen_at: opts.observedAt,
        last_seen_at: opts.observedAt,
        url: posUrl,
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
