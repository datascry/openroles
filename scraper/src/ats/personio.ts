import { type Job, jobId, type TenantInput, type TenantResult } from "@openroles/shared";
import { XMLParser } from "fast-xml-parser";
import type { HttpClient } from "../http.ts";
import { assertSafeSlug, dedupeById, errorToResult } from "./common.ts";

interface PersonioPosition {
  id?: string | number;
  name?: string;
  jobDescription?: { jobDescription?: { name?: string; value?: string }[] };
  office?: string;
  department?: string;
  schedule?: string;
  employmentType?: string;
  createdAt?: string;
  occupationCategory?: string;
  recruitingCategory?: string;
}

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseAttributeValue: false,
  trimValues: true,
});

function descriptionText(desc: PersonioPosition["jobDescription"]): string | undefined {
  if (!desc?.jobDescription) return undefined;
  const sections = Array.isArray(desc.jobDescription) ? desc.jobDescription : [desc.jobDescription];
  const parts = sections.map((s) => s?.value ?? "").filter((s) => s.length > 0);
  if (parts.length === 0) return undefined;
  return parts.join("\n").slice(0, 4000);
}

function isoOrUndefined(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

export interface ScrapePersonioOptions {
  readonly tenant: TenantInput;
  readonly client: HttpClient;
  readonly observedAt: string;
}

export interface ScrapePersonioOutcome {
  readonly jobs: ReadonlyArray<Job>;
  readonly result: TenantResult;
}

export async function scrapePersonioTenant(
  opts: ScrapePersonioOptions,
): Promise<ScrapePersonioOutcome> {
  try {
    assertSafeSlug(opts.tenant.slug);
    const url = `https://${opts.tenant.slug}.jobs.personio.com/xml`;
    const res = await opts.client.request(url);
    const xml = await res.text();
    const parsed = xmlParser.parse(xml) as {
      "workzag-jobs"?: { position?: PersonioPosition | PersonioPosition[] };
    };
    const raw = parsed["workzag-jobs"]?.position;
    const positions: PersonioPosition[] = Array.isArray(raw) ? raw : raw ? [raw] : [];
    const company = opts.tenant.display_name ?? opts.tenant.slug;
    const jobs: Job[] = [];
    for (const p of positions) {
      if (p.id === undefined || !p.name) continue;
      const sourceId = String(p.id);
      const posUrl = `https://${opts.tenant.slug}.jobs.personio.com/job/${sourceId}`;
      const id = jobId({
        ats: "personio",
        tenant_slug: opts.tenant.slug,
        source_id: sourceId,
        url: posUrl,
      });
      const postedAt = isoOrUndefined(p.createdAt);
      const desc = descriptionText(p.jobDescription);
      jobs.push({
        id,
        ats: "personio",
        tenant_slug: opts.tenant.slug,
        source_id: sourceId,
        title: p.name,
        company,
        ...(desc ? { description_excerpt: desc } : {}),
        level: null,
        level_rank: null,
        workplace_type: null,
        is_recruiter_post: false,
        ...(p.office ? { location_text: p.office } : {}),
        ...(p.department ? { department: p.department } : {}),
        ...(postedAt ? { posted_at: postedAt } : {}),
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
