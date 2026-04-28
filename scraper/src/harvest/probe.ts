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
  recruitee: (slug) => `https://${slug}.recruitee.com/api/offers/`,
  breezy: (slug) => `https://${slug}.breezy.hr/json`,
  personio: (slug) => `https://${slug}.jobs.personio.com/xml`,
  // Workable's v3 endpoint (`/api/v3/accounts/{slug}/jobs`) returns 404 for
  // every tenant, including known-live ones. The v1 widget API at
  // `/api/v1/widget/accounts/{slug}` is the actual public read-only path
  // and returns `{ name, description, jobs: [...] }`.
  workable: (slug) => `https://apply.workable.com/api/v1/widget/accounts/${slug}`,
  // /jobs.json returns 406 (content-type negotiation, no auth) even with
  // an explicit Accept header; /jobs.rss is the public read-only feed that
  // works without auth.
  teamtailor: (slug) => `https://${slug}.teamtailor.com/jobs.rss`,
  smartrecruiters: (slug) =>
    `https://api.smartrecruiters.com/v1/companies/${slug}/postings?limit=1`,
  csod: (slug) => `https://${slug}.csod.com/`,
  // Taleo career sites live under either `{tenant}.taleo.net` or the TBE
  // pool `{tenant}.tbe.taleo.net`; the careersection root returns 200 on both.
  taleo: (slug) => `https://${slug}.taleo.net/careersection/`,
  jobvite: (slug) => `https://jobs.jobvite.com/${slug}`,
  zohorecruit: (slug) => `https://${slug}.zohorecruit.com/jobs/Careers`,
  talentlyft: (slug) => `https://${slug}.talentlyft.com/`,
  pinpointhq: (slug) => `https://${slug}.pinpointhq.com/`,
  applicantpro: (slug) => `https://${slug}.applicantpro.com/jobs/`,
  applicantstack: (slug) => `https://${slug}.applicantstack.com/`,
  // The tenant landing page (`{slug}.homerun.co`) returns 200 on the empty
  // careers stub too. The Atom feed at `feed.homerun.co/{slug}` is the
  // signal we actually care about — a tenant without a published feed
  // returns 404 here.
  homerun: (slug) => `https://feed.homerun.co/${slug}`,
  factorial: (slug) => `https://${slug}.factorialhr.com/`,
  eightfold: (slug) => `https://${slug}.eightfold.ai/careers`,
  // ultipro: deliberately omitted — `recruiting.ultipro.com/{CODE}/JobBoard/`
  // requires a per-tenant GUID we cannot derive from the slug alone, so the
  // probe would always return a misleading 404. Treated like workday: the
  // dispatcher emits transient_failure and the caller may supply the
  // tenant.metadata.{board_id} once a scraper lands.
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
  // workday and ultipro both compose URLs from a (tenant_code + per-board
  // GUID) pair we cannot derive from the slug alone; mark transient until
  // the metadata is supplied.
  if (ats === "workday" || ats === "ultipro") {
    return { ats, slug, status: "transient_failure", last_probed_at: observedAt };
  }
  try {
    // Some ATS API hosts publish robots.txt with `Disallow: /` even though
    // their public read-only API is documented and intended for programmatic
    // use (smartrecruiters whitelists LinkedInBot, others are silent).
    // Treat the probe URL as an API call rather than a crawl.
    await client.request(probeUrlFor(ats, slug), { method: "GET", skipRobots: true });
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
