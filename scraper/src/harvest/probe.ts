import type { ATSId, Tenant, TenantStatus } from "@openroles/shared";
import pLimit from "p-limit";
import { type HttpClient, HttpError } from "../http.ts";

export type ProbeUrlBuilder = (slug: string) => string;

const PROBE_URL: Partial<Record<ATSId, ProbeUrlBuilder>> = {
  greenhouse: (slug) => `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=false`,
  lever: (slug) => `https://api.lever.co/v0/postings/${slug}?mode=json&limit=1`,
  ashby: (slug) => `https://api.ashbyhq.com/posting-api/job-board/${slug}`,
  bamboohr: (slug) => `https://${slug}.bamboohr.com/careers/list`,
  // iCIMS slug = full subdomain label (most use a `careers-` prefix but many
  // use other branded prefixes; see harvest/patterns.ts).
  icims: (slug) => `https://${slug}.icims.com/sitemap.xml`,
};

export function probeUrlFor(ats: ATSId, slug: string): string {
  const build = PROBE_URL[ats];
  if (!build) throw new Error(`probe URL not defined for ats ${ats}`);
  return build(slug);
}

export interface ProbeOptions {
  readonly client: HttpClient;
  readonly observedAt: string;
  readonly concurrency?: number;
}

const DEFAULT_PROBE_CONCURRENCY = 6;
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export async function probeOne(
  ats: ATSId,
  slug: string,
  client: HttpClient,
  observedAt: string,
): Promise<Tenant> {
  if (!SLUG_RE.test(slug)) {
    return { ats, slug, status: "dead", last_probed_at: observedAt };
  }
  if (ats === "workday") {
    return { ats, slug, status: "transient_failure", last_probed_at: observedAt };
  }
  try {
    await client.request(probeUrlFor(ats, slug), { method: "GET" });
    return { ats, slug, status: "live", last_probed_at: observedAt };
  } catch (err) {
    if (err instanceof HttpError) {
      const status: TenantStatus = err.kind === "transient" ? "transient_failure" : "dead";
      return { ats, slug, status, last_probed_at: observedAt };
    }
    return { ats, slug, status: "transient_failure", last_probed_at: observedAt };
  }
}

export function probeMany(
  ats: ATSId,
  slugs: ReadonlyArray<string>,
  opts: ProbeOptions,
): Promise<Tenant[]> {
  const limit = pLimit(opts.concurrency ?? DEFAULT_PROBE_CONCURRENCY);
  return Promise.all(
    slugs.map((slug) => limit(() => probeOne(ats, slug, opts.client, opts.observedAt))),
  );
}
