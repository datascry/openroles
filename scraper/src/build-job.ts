import { type ATSId, type Job, jobId, levelRank } from "@openroles/shared";
import { excerpt, normalizeWorkplace, plainText, splitLocation } from "./normalize.ts";

export interface BuildJobInput {
  readonly ats: ATSId;
  readonly tenant_slug: string;
  readonly company: string;
  readonly source_id: string;
  readonly title: string;
  readonly url: string;
  readonly description_html?: string;
  readonly description_text?: string;
  readonly location_text?: string;
  readonly workplace_hint?: string;
  readonly department?: string;
  readonly posted_at?: string;
  readonly updated_at?: string;
  readonly compensation_min?: number;
  readonly compensation_max?: number;
  readonly compensation_currency?: string;
  readonly is_recruiter_post?: boolean;
  readonly first_seen_at: string;
  readonly last_seen_at: string;
}

export function buildJob(input: BuildJobInput): Job {
  const id = jobId({
    ats: input.ats,
    tenant_slug: input.tenant_slug,
    source_id: input.source_id,
    url: input.url,
  });

  const description = input.description_text ?? plainText(input.description_html);
  const descriptionExcerpt = description ? excerpt(description) : undefined;

  const locationText = input.location_text;
  const loc = locationText ? splitLocation(locationText) : undefined;
  const workplaceType = normalizeWorkplace(input.workplace_hint ?? locationText);

  const job: Job = {
    id,
    ats: input.ats,
    tenant_slug: input.tenant_slug,
    source_id: input.source_id,
    title: input.title.trim(),
    company: input.company.trim(),
    level: null,
    level_rank: levelRank(null),
    workplace_type: workplaceType,
    is_recruiter_post: input.is_recruiter_post ?? false,
    first_seen_at: input.first_seen_at,
    last_seen_at: input.last_seen_at,
    url: input.url,
    ...(descriptionExcerpt ? { description_excerpt: descriptionExcerpt } : {}),
    ...(locationText ? { location_text: locationText } : {}),
    ...(loc?.country !== undefined ? { location_country: loc.country } : {}),
    ...(loc?.region !== undefined ? { location_region: loc.region } : {}),
    ...(input.compensation_min !== undefined ? { compensation_min: input.compensation_min } : {}),
    ...(input.compensation_max !== undefined ? { compensation_max: input.compensation_max } : {}),
    ...(input.compensation_currency ? { compensation_currency: input.compensation_currency } : {}),
    ...(input.department ? { department: input.department } : {}),
    ...(input.posted_at ? { posted_at: input.posted_at } : {}),
    ...(input.updated_at ? { updated_at: input.updated_at } : {}),
  };

  return job;
}
