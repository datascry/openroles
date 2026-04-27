import { type Job, jobId, type TenantInput, type TenantResult } from "@openroles/shared";
import type { HttpClient } from "../http.ts";
import { assertSafeSlug, dedupeById, errorToResult } from "./common.ts";

interface WorkableJob {
  id?: string | number;
  shortcode?: string;
  title?: string;
  full_title?: string;
  url?: string;
  application_url?: string;
  shortlink?: string;
  state?: string;
  department?: string;
  location?: { country_code?: string; city?: string; region?: string; location_str?: string };
  remote?: boolean;
  workplace?: string;
  employment_type?: string;
  description?: string;
  published_on?: string;
  created_at?: string;
}

interface WorkableResponse {
  results?: ReadonlyArray<WorkableJob>;
  jobs?: ReadonlyArray<WorkableJob>;
}

function workplaceFromJob(j: WorkableJob): Job["workplace_type"] {
  if (j.remote === true) return "remote";
  const wp = j.workplace?.toLowerCase();
  if (wp === "remote") return "remote";
  if (wp === "hybrid") return "hybrid";
  if (wp === "on-site" || wp === "onsite") return "onsite";
  return null;
}

function isoOrUndefined(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

export interface ScrapeWorkableOptions {
  readonly tenant: TenantInput;
  readonly client: HttpClient;
  readonly observedAt: string;
}

export interface ScrapeWorkableOutcome {
  readonly jobs: ReadonlyArray<Job>;
  readonly result: TenantResult;
}

export async function scrapeWorkableTenant(
  opts: ScrapeWorkableOptions,
): Promise<ScrapeWorkableOutcome> {
  try {
    assertSafeSlug(opts.tenant.slug);
    const url = `https://apply.workable.com/api/v3/accounts/${opts.tenant.slug}/jobs`;
    const res = await opts.client.request(url);
    const body = (await res.json()) as WorkableResponse;
    const items = body.results ?? body.jobs ?? [];
    const company = opts.tenant.display_name ?? opts.tenant.slug;
    const jobs: Job[] = [];
    for (const j of items) {
      const sourceId = j.shortcode ?? (j.id !== undefined ? String(j.id) : undefined);
      const title = j.title ?? j.full_title;
      if (!sourceId || !title) continue;
      const jobUrl =
        j.url ??
        j.application_url ??
        j.shortlink ??
        `https://apply.workable.com/${opts.tenant.slug}/j/${sourceId}`;
      const id = jobId({
        ats: "workable",
        tenant_slug: opts.tenant.slug,
        source_id: sourceId,
        url: jobUrl,
      });
      const postedAt = isoOrUndefined(j.published_on ?? j.created_at);
      jobs.push({
        id,
        ats: "workable",
        tenant_slug: opts.tenant.slug,
        source_id: sourceId,
        title,
        company,
        ...(j.description ? { description_excerpt: j.description.slice(0, 4000) } : {}),
        level: null,
        level_rank: null,
        workplace_type: workplaceFromJob(j),
        is_recruiter_post: false,
        ...(j.location?.location_str ? { location_text: j.location.location_str } : {}),
        ...(j.location?.country_code
          ? { location_country: j.location.country_code.toUpperCase() }
          : {}),
        ...(j.location?.city ? { location_region: j.location.city } : {}),
        ...(j.department ? { department: j.department } : {}),
        ...(postedAt ? { posted_at: postedAt } : {}),
        first_seen_at: opts.observedAt,
        last_seen_at: opts.observedAt,
        url: jobUrl,
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
