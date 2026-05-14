import {
  type ATSId,
  type Job,
  type ScrapeInput,
  ScrapeInputSchema,
  type ScrapeOutput,
  type TenantInput,
  type TenantResult,
} from "@openroles/shared";
import pLimit from "p-limit";
import { scrapeAmazonJobsTenant } from "./ats/amazonjobs.ts";
import { scrapeAppleJobsTenant } from "./ats/applejobs.ts";
import { scrapeApplicantProTenant } from "./ats/applicantpro.ts";
import { scrapeApplicantStackTenant } from "./ats/applicantstack.ts";
import { scrapeAshbyTenant } from "./ats/ashby.ts";
import { scrapeBambooTenant } from "./ats/bamboohr.ts";
import { scrapeBrassringTenant } from "./ats/brassring.ts";
import { scrapeBreezyTenant } from "./ats/breezy.ts";
import { scrapeCsodTenant } from "./ats/csod.ts";
import { scrapeEightfoldTenant } from "./ats/eightfold.ts";
import { scrapeFactorialTenant } from "./ats/factorial.ts";
import { scrapeGreenhouseTenant } from "./ats/greenhouse.ts";
import { scrapeHomerunTenant } from "./ats/homerun.ts";
import { scrapeIcimsTenant } from "./ats/icims.ts";
import { scrapeJobviteTenant } from "./ats/jobvite.ts";
import { scrapeJsonldTenant } from "./ats/jsonld.ts";
import { scrapeLeverTenant } from "./ats/lever.ts";
import { scrapeMetaCareersTenant } from "./ats/metacareers.ts";
import { scrapePersonioTenant } from "./ats/personio.ts";
import { scrapePinpointHqTenant } from "./ats/pinpointhq.ts";
import { scrapeRecruiteeTenant } from "./ats/recruitee.ts";
import { scrapeSmartRecruitersTenant } from "./ats/smartrecruiters.ts";
import { scrapeSuccessFactorsTenant } from "./ats/successfactors.ts";
import { scrapeTalentlyftTenant } from "./ats/talentlyft.ts";
import { scrapeTaleoTenant } from "./ats/taleo.ts";
import { scrapeTeamtailorTenant } from "./ats/teamtailor.ts";
import { scrapeTiktokCareersTenant } from "./ats/tiktokcareers.ts";
import { scrapeUltiproTenant } from "./ats/ultipro.ts";
import { scrapeWorkableTenant } from "./ats/workable.ts";
import { scrapeWorkdayTenant } from "./ats/workday.ts";
import { scrapeZohorecruitTenant } from "./ats/zohorecruit.ts";
import { HttpClient, type RetryPolicy } from "./http.ts";
import { RobotsTxtCache } from "./robots.ts";

export interface ScrapeRunOptions {
  readonly input: ScrapeInput;
  readonly clock?: () => Date;
  readonly httpClient?: HttpClient;
  readonly robotsCache?: RobotsTxtCache;
}

const DEFAULT_CONCURRENCY = 10;

export async function runScrape(opts: ScrapeRunOptions): Promise<ScrapeOutput> {
  const input = ScrapeInputSchema.parse(opts.input);
  const clock = opts.clock ?? (() => new Date());
  const startedAt = clock();
  const observedAtIso = startedAt.toISOString();

  const robots = opts.robotsCache ?? new RobotsTxtCache();
  const retry: RetryPolicy = input.retry ?? {
    maxAttempts: 3,
    baseMs: 500,
    maxMs: 30_000,
  };
  const client =
    opts.httpClient ??
    new HttpClient({
      userAgent: input.userAgent,
      robots,
      retry,
    });

  const limit = pLimit(input.concurrency ?? DEFAULT_CONCURRENCY);
  const perTenant: Array<{
    jobs: ReadonlyArray<Job>;
    result: TenantResult;
  }> = new Array(input.tenants.length);

  await Promise.all(
    input.tenants.map((tenant, idx) =>
      limit(async () => {
        const out = await dispatchPerAts(input.ats, {
          tenant,
          client,
          observedAt: observedAtIso,
        });
        perTenant[idx] = out;
      }),
    ),
  );

  const allJobs: Job[] = [];
  const tenantResults: TenantResult[] = [];
  for (const slot of perTenant) {
    if (!slot) continue;
    for (const j of slot.jobs) allJobs.push(j);
    tenantResults.push(slot.result);
  }

  const finishedAt = clock();
  return {
    ats: input.ats,
    jobs: allJobs,
    tenant_results: tenantResults,
    metrics: {
      started_at: startedAt.toISOString(),
      finished_at: finishedAt.toISOString(),
      duration_ms: finishedAt.getTime() - startedAt.getTime(),
      requests_made: client.metrics.requestsMade,
      requests_failed: client.metrics.requestsFailed,
      requests_retried: client.metrics.requestsRetried,
      bytes_received: client.metrics.bytesReceived,
    },
  };
}

interface DispatchOpts {
  readonly tenant: TenantInput;
  readonly client: HttpClient;
  readonly observedAt: string;
}

function dispatchPerAts(
  ats: ATSId,
  opts: DispatchOpts,
): Promise<{ jobs: ReadonlyArray<Job>; result: TenantResult }> {
  switch (ats) {
    case "greenhouse":
      return scrapeGreenhouseTenant(opts);
    case "lever":
      return scrapeLeverTenant(opts);
    case "ashby":
      return scrapeAshbyTenant(opts);
    case "bamboohr":
      return scrapeBambooTenant(opts);
    case "workday": {
      const host = opts.tenant.metadata?.["host"];
      // Default site to "External" when missing — that's the canonical
      // public-facing site name across the workday ecosystem (most
      // tenants expose `External`, a few use `Careers` or custom
      // names). The S3 bootstrap captured `host` for ~all 4,295
      // tenants but only ~44 had `site` from CDX (most CDX URLs are
      // bare host pages, not `/<site>` deep links). Without this
      // fallback the dispatcher silently rejects 98.9% of tenants
      // before the scraper even runs. Mirrors the same default in
      // harvest/probe.ts:PROBE_URL_META.workday so probe and scrape
      // agree on which URL to hit.
      const site = opts.tenant.metadata?.["site"] ?? "External";
      if (host === undefined) {
        return Promise.resolve({
          jobs: [],
          result: {
            slug: opts.tenant.slug,
            status: "dead",
            error: "workday tenant missing metadata.host",
            jobs_count: 0,
          },
        });
      }
      return scrapeWorkdayTenant({ ...opts, host, site });
    }
    case "icims":
      return scrapeIcimsTenant(opts);
    case "recruitee":
      return scrapeRecruiteeTenant(opts);
    case "breezy":
      return scrapeBreezyTenant(opts);
    case "personio":
      return scrapePersonioTenant(opts);
    case "workable":
      return scrapeWorkableTenant(opts);
    case "smartrecruiters":
      return scrapeSmartRecruitersTenant(opts);
    case "pinpointhq":
      return scrapePinpointHqTenant(opts);
    case "teamtailor":
      return scrapeTeamtailorTenant(opts);
    case "talentlyft":
      return scrapeTalentlyftTenant(opts);
    case "jobvite":
      return scrapeJobviteTenant(opts);
    case "homerun":
      return scrapeHomerunTenant(opts);
    case "factorial":
      return scrapeFactorialTenant(opts);
    case "applicantpro":
      return scrapeApplicantProTenant(opts);
    case "applicantstack":
      return scrapeApplicantStackTenant(opts);
    case "eightfold":
      return scrapeEightfoldTenant(opts);
    case "ultipro":
      return scrapeUltiproTenant(opts);
    case "csod":
      return scrapeCsodTenant(opts);
    case "taleo":
      // Standard pool only (`{slug}.taleo.net`). The TBE pool requires a
      // per-tenant `org=<CODE>` parameter we don't capture in harvest;
      // when TBE-specific metadata lands, gate that variant here. The
      // scraper discovers the careersection portalNo from the section
      // HTML, so no metadata is required for the standard pool.
      return scrapeTaleoTenant(opts);
    case "zohorecruit":
      return scrapeZohorecruitTenant(opts);
    case "amazonjobs":
      return scrapeAmazonJobsTenant(opts);
    case "applejobs":
      return scrapeAppleJobsTenant(opts);
    case "tiktokcareers":
      return scrapeTiktokCareersTenant(opts);
    case "metacareers":
      return scrapeMetaCareersTenant(opts);
    case "successfactors": {
      // SuccessFactors needs a regional-datacenter host
      // (`career{N}.successfactors.{tld}`). Harvest captures it via
      // the patterns regex; tenants whose record lacks it are marked
      // dead by the dispatcher (matches the workday/ultipro pattern
      // where composite metadata is mandatory and not slug-derivable).
      const host = opts.tenant.metadata?.["host"];
      if (host === undefined) {
        return Promise.resolve({
          jobs: [],
          result: {
            slug: opts.tenant.slug,
            status: "dead",
            error: "successfactors tenant missing metadata.host",
            jobs_count: 0,
          },
        });
      }
      return scrapeSuccessFactorsTenant({ ...opts, host });
    }
    case "jsonld": {
      // Vendor-agnostic JSON-LD harvester. Per-tenant `sitemap_url`
      // metadata is mandatory — the adapter can't derive the sitemap
      // location from the slug alone (the whole point of this ATS is
      // to support brands with proprietary careers stacks where the
      // URL shape is per-brand).
      const sitemapUrl = opts.tenant.metadata?.["sitemap_url"];
      if (sitemapUrl === undefined) {
        return Promise.resolve({
          jobs: [],
          result: {
            slug: opts.tenant.slug,
            status: "dead",
            error: "jsonld tenant missing metadata.sitemap_url",
            jobs_count: 0,
          },
        });
      }
      return scrapeJsonldTenant({ ...opts, sitemapUrl });
    }
    case "brassring": {
      // BrassRing tenants share the host sjobs.brassring.com; the
      // (partnerid, siteid) pair selects the tenant. Both are numeric
      // IDs captured as strings in metadata (digits only — see
      // assertBrassringIds in the adapter).
      const partnerId = opts.tenant.metadata?.["partnerid"];
      const siteId = opts.tenant.metadata?.["siteid"];
      if (partnerId === undefined || siteId === undefined) {
        return Promise.resolve({
          jobs: [],
          result: {
            slug: opts.tenant.slug,
            status: "dead",
            error: "brassring tenant missing metadata.partnerid or metadata.siteid",
            jobs_count: 0,
          },
        });
      }
      return scrapeBrassringTenant({ ...opts, partnerId, siteId });
    }
  }
}
