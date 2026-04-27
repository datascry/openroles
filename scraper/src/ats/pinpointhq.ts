import { type Job, JobSchema, jobId, type TenantInput, type TenantResult } from "@openroles/shared";
import type { HttpClient } from "../http.ts";
import { assertSafeSlug, dedupeById, errorToResult } from "./common.ts";

interface PinpointLocation {
  id?: string | number;
  name?: string;
}

interface PinpointDepartment {
  id?: string | number;
  name?: string;
}

interface PinpointJob {
  id?: string | number;
  title?: string;
  description?: string;
  url?: string;
  path?: string;
  requisition_id?: string;
  employment_type?: string;
  workplace_type?: string;
  workplace_type_text?: string;
  location?: PinpointLocation | null;
  department?: PinpointDepartment | null;
  compensation_minimum?: number | null;
  compensation_maximum?: number | null;
  compensation_currency?: string | null;
  deadline_at?: string | null;
}

interface PinpointResponse {
  data?: ReadonlyArray<PinpointJob>;
}

function workplaceFromText(value: string | undefined): Job["workplace_type"] {
  switch (value) {
    case "remote":
      return "remote";
    case "hybrid":
      return "hybrid";
    case "onsite":
    case "on_site":
    case "office":
      return "onsite";
    default:
      return null;
  }
}

function nonNegativeIntOrUndefined(value: number | null | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return Math.trunc(value);
}

export interface ScrapePinpointHqOptions {
  readonly tenant: TenantInput;
  readonly client: HttpClient;
  readonly observedAt: string;
}

export interface ScrapePinpointHqOutcome {
  readonly jobs: ReadonlyArray<Job>;
  readonly result: TenantResult;
}

export async function scrapePinpointHqTenant(
  opts: ScrapePinpointHqOptions,
): Promise<ScrapePinpointHqOutcome> {
  try {
    assertSafeSlug(opts.tenant.slug);
    const url = `https://${opts.tenant.slug}.pinpointhq.com/jobs.json`;
    const res = await opts.client.request(url);
    const body = (await res.json()) as PinpointResponse;
    const company = opts.tenant.display_name ?? opts.tenant.slug;
    const jobs: Job[] = [];
    for (const j of body.data ?? []) {
      const sourceId = j.id !== undefined ? String(j.id) : j.requisition_id;
      if (!sourceId || !j.title) continue;
      const jobUrl =
        j.url ??
        (j.path
          ? `https://${opts.tenant.slug}.pinpointhq.com${j.path}`
          : `https://${opts.tenant.slug}.pinpointhq.com/jobs/${sourceId}`);
      const id = jobId({
        ats: "pinpointhq",
        tenant_slug: opts.tenant.slug,
        source_id: sourceId,
        url: jobUrl,
      });
      const compMin = nonNegativeIntOrUndefined(j.compensation_minimum ?? undefined);
      const compMax = nonNegativeIntOrUndefined(j.compensation_maximum ?? undefined);
      const compCur =
        typeof j.compensation_currency === "string" && /^[A-Z]{3}$/.test(j.compensation_currency)
          ? j.compensation_currency
          : undefined;
      const trimmedDesc = j.description?.trim();
      // `deadline_at` is the application close date (often in the future),
      // not an updated_at marker — don't map it onto Job.updated_at because
      // the schema requires updated_at <= last_seen_at.
      const candidate = {
        id,
        ats: "pinpointhq",
        tenant_slug: opts.tenant.slug,
        source_id: sourceId,
        title: j.title,
        company,
        ...(trimmedDesc ? { description_excerpt: trimmedDesc.slice(0, 4000) } : {}),
        level: null,
        level_rank: null,
        workplace_type: workplaceFromText(j.workplace_type),
        is_recruiter_post: false,
        ...(j.location?.name ? { location_text: j.location.name } : {}),
        ...(j.department?.name ? { department: j.department.name } : {}),
        ...(compMin !== undefined ? { compensation_min: compMin } : {}),
        ...(compMax !== undefined ? { compensation_max: compMax } : {}),
        ...(compCur ? { compensation_currency: compCur } : {}),
        first_seen_at: opts.observedAt,
        last_seen_at: opts.observedAt,
        url: jobUrl,
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
