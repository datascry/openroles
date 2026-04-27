import { type Job, JobSchema, type TenantInput, type TenantResult } from "@openroles/shared";
import { z } from "zod";
import { buildJob } from "../build-job.ts";
import type { HttpClient } from "../http.ts";
import {
  assertSafeSlug,
  dedupeById,
  epochToIso,
  errorToResult,
  isRecruiterTitle,
} from "./common.ts";

const LeverCategories = z
  .object({
    team: z.string().optional(),
    department: z.string().optional(),
    location: z.string().optional(),
    commitment: z.string().optional(),
    allLocations: z.array(z.string()).optional(),
  })
  .optional();

const LeverPosting = z
  .object({
    id: z.string(),
    text: z.string(),
    hostedUrl: z.url(),
    applyUrl: z.url().optional(),
    createdAt: z.number().optional(),
    updatedAt: z.number().optional(),
    workplaceType: z.string().optional(),
    descriptionPlain: z.string().optional(),
    description: z.string().optional(),
    categories: LeverCategories,
    additional: z.string().optional(),
  })
  .passthrough();

const LeverResponse = z.array(LeverPosting);

export interface LeverParseInput {
  readonly tenant: TenantInput;
  readonly company: string;
  readonly response: unknown;
  readonly observedAt: string;
}

export function parseLeverPostings(input: LeverParseInput): Job[] {
  const parsed = LeverResponse.parse(input.response);
  const jobs: Job[] = [];
  for (const raw of parsed) {
    const cat = raw.categories;
    const location = cat?.location;
    const department = cat?.department ?? cat?.team;
    const description = raw.descriptionPlain ?? raw.description;
    const postedAt = epochToIso(raw.createdAt);
    const updatedAt = epochToIso(raw.updatedAt);
    const workplaceHint = [raw.workplaceType, location, description?.slice(0, 200)]
      .filter((s): s is string => typeof s === "string" && s.length > 0)
      .join(" ");
    const candidate = buildJob({
      ats: "lever",
      tenant_slug: input.tenant.slug,
      company: input.company,
      source_id: raw.id,
      title: raw.text,
      url: raw.hostedUrl,
      ...(raw.descriptionPlain !== undefined
        ? { description_text: raw.descriptionPlain }
        : raw.description !== undefined
          ? { description_html: raw.description }
          : {}),
      ...(location !== undefined ? { location_text: location } : {}),
      workplace_hint: workplaceHint,
      ...(department !== undefined ? { department } : {}),
      ...(postedAt !== undefined ? { posted_at: postedAt } : {}),
      ...(updatedAt !== undefined ? { updated_at: updatedAt } : {}),
      is_recruiter_post: isRecruiterTitle(raw.text),
      first_seen_at: input.observedAt,
      last_seen_at: input.observedAt,
    });
    const validated = JobSchema.safeParse(candidate);
    if (validated.success) jobs.push(validated.data);
  }
  return dedupeById(jobs);
}

export interface ScrapeTenantOptions {
  readonly tenant: TenantInput;
  readonly client: HttpClient;
  readonly observedAt: string;
}

export interface ScrapeTenantOutcome {
  readonly jobs: ReadonlyArray<Job>;
  readonly result: TenantResult;
}

export async function scrapeLeverTenant(opts: ScrapeTenantOptions): Promise<ScrapeTenantOutcome> {
  try {
    assertSafeSlug(opts.tenant.slug);
    const url = `https://api.lever.co/v0/postings/${opts.tenant.slug}?mode=json`;
    const res = await opts.client.request(url);
    const body = await res.json();
    const jobs = parseLeverPostings({
      tenant: opts.tenant,
      company: opts.tenant.display_name ?? opts.tenant.slug,
      response: body,
      observedAt: opts.observedAt,
    });
    return {
      jobs,
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
