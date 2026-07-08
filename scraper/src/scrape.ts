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
import { scrapeApplicantpoolTenant } from "./ats/applicantpool.ts";
import { scrapeApplicantProTenant } from "./ats/applicantpro.ts";
import { scrapeApplicantStackTenant } from "./ats/applicantstack.ts";
import { scrapeApplitrackTenant } from "./ats/applitrack.ts";
import { scrapeApploiTenant } from "./ats/apploi.ts";
import { scrapeAshbyTenant } from "./ats/ashby.ts";
import { scrapeBambooTenant } from "./ats/bamboohr.ts";
import { scrapeBrassringTenant } from "./ats/brassring.ts";
import { scrapeBreezyTenant } from "./ats/breezy.ts";
import { scrapeCareerplugTenant } from "./ats/careerplug.ts";
import { scrapeCsodTenant } from "./ats/csod.ts";
import { scrapeEightfoldTenant } from "./ats/eightfold.ts";
import { scrapeFactorialTenant } from "./ats/factorial.ts";
import { scrapeGjobsfeedTenant } from "./ats/gjobsfeed.ts";
import { scrapeGreenhouseTenant } from "./ats/greenhouse.ts";
import { scrapeHirebridgeTenant } from "./ats/hirebridge.ts";
import { scrapeHireologyTenant } from "./ats/hireology.ts";
import { scrapeHiringthingTenant } from "./ats/hiringthing.ts";
import { scrapeHomerunTenant } from "./ats/homerun.ts";
import { scrapeHrmDirectTenant } from "./ats/hrmdirect.ts";
import { scrapeIcimsTenant } from "./ats/icims.ts";
import { scrapeIsolvedhireTenant } from "./ats/isolvedhire.ts";
import { scrapeJazzHrTenant } from "./ats/jazzhr.ts";
import { scrapeJibeapplyTenant } from "./ats/jibeapply.ts";
import { scrapeJobscoreTenant } from "./ats/jobscore.ts";
import { scrapeJobviteTenant } from "./ats/jobvite.ts";
import { scrapeJsonldTenant } from "./ats/jsonld.ts";
import { scrapeLeverTenant } from "./ats/lever.ts";
import { scrapeManatalTenant } from "./ats/manatal.ts";
import { scrapeMetaCareersTenant } from "./ats/metacareers.ts";
import { scrapeOracleCloudTenant } from "./ats/oraclecloud.ts";
import { scrapePageupTenant } from "./ats/pageup.ts";
import { scrapePaycomTenant } from "./ats/paycom.ts";
import { scrapePersonioTenant } from "./ats/personio.ts";
import { PHENOM_DEFAULT_LOCALE, scrapePhenomTenant } from "./ats/phenom.ts";
import { scrapePinpointHqTenant } from "./ats/pinpointhq.ts";
import { scrapeRecruiteeTenant } from "./ats/recruitee.ts";
import { scrapeRipplingTenant } from "./ats/rippling.ts";
import { scrapeSchoolSpringTenant } from "./ats/schoolspring.ts";
import { scrapeSmartRecruitersTenant } from "./ats/smartrecruiters.ts";
import { scrapeSuccessFactorsTenant } from "./ats/successfactors.ts";
import { scrapeTalentbrewTenant } from "./ats/talentbrew.ts";
import { scrapeTalentlyftTenant } from "./ats/talentlyft.ts";
import { scrapeTaleoTenant } from "./ats/taleo.ts";
import { scrapeTaleoTbeTenant } from "./ats/taleotbe.ts";
import { scrapeTeamtailorTenant } from "./ats/teamtailor.ts";
import { scrapeTiktokCareersTenant } from "./ats/tiktokcareers.ts";
import { scrapeUltiproTenant } from "./ats/ultipro.ts";
import { scrapeWorkableTenant } from "./ats/workable.ts";
import { scrapeWorkdayTenant } from "./ats/workday.ts";
import { scrapeWorkstreamTenant } from "./ats/workstream.ts";
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

// The vanity host is optional, so the metadata lookup lives outside
// dispatchPerAts to keep that switch under the complexity ceiling.
function dispatchJibeapply(
  opts: DispatchOpts,
): Promise<{ jobs: ReadonlyArray<Job>; result: TenantResult }> {
  const host = opts.tenant.metadata?.["host"];
  return scrapeJibeapplyTenant({ ...opts, ...(host !== undefined ? { host } : {}) });
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
      // Enterprise pool only (`{slug}.taleo.net`). The scraper discovers
      // the careersection portalNo from the section HTML, so no metadata
      // is required. Taleo Business Edition boards are a separate ATS id
      // (`taleotbe`) with composite tenancy — see that case below.
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
    case "gjobsfeed": {
      // Google-for-Jobs RSS feed harvester. Per-tenant `feed_url`
      // metadata is mandatory — vendor-agnostic, the feed location is
      // per-brand and not slug-derivable (same convention as jsonld).
      const feedUrl = opts.tenant.metadata?.["feed_url"];
      if (feedUrl === undefined) {
        return Promise.resolve({
          jobs: [],
          result: {
            slug: opts.tenant.slug,
            status: "dead",
            error: "gjobsfeed tenant missing metadata.feed_url",
            jobs_count: 0,
          },
        });
      }
      return scrapeGjobsfeedTenant({ ...opts, feedUrl });
    }
    case "oraclecloud": {
      // Oracle Fusion HCM Candidate Experience. Tenant identity is the
      // composite (host, site): the Fusion pod host plus the CE site code
      // (`siteNumber`). Both are mandatory and not slug-derivable, so a
      // tenant missing either is marked dead — same convention as workday's
      // host/site and successfactors' host.
      const host = opts.tenant.metadata?.["host"];
      const site = opts.tenant.metadata?.["site"];
      if (host === undefined || site === undefined) {
        return Promise.resolve({
          jobs: [],
          result: {
            slug: opts.tenant.slug,
            status: "dead",
            error: "oraclecloud tenant missing metadata.host or metadata.site",
            jobs_count: 0,
          },
        });
      }
      return scrapeOracleCloudTenant({ ...opts, host, site });
    }
    case "jazzhr":
      // Slug-only tenancy: the board host is `{slug}.applytojob.com` and
      // every job URL is the canonical apply link, so no metadata is needed.
      return scrapeJazzHrTenant(opts);
    case "phenom": {
      // Phenom career site. `host` is the (often vanity) careers domain and
      // is mandatory; `locale` (the `{country}/{lang}` path segment) defaults
      // to us/en when absent. Host missing → dead, same as workday.
      const host = opts.tenant.metadata?.["host"];
      const locale = opts.tenant.metadata?.["locale"] ?? PHENOM_DEFAULT_LOCALE;
      if (host === undefined) {
        return Promise.resolve({
          jobs: [],
          result: {
            slug: opts.tenant.slug,
            status: "dead",
            error: "phenom tenant missing metadata.host",
            jobs_count: 0,
          },
        });
      }
      return scrapePhenomTenant({ ...opts, host, locale });
    }
    case "hrmdirect":
      // Slug-only tenancy: the board host is `{slug}.hrmdirect.com` and the
      // single listing page carries every role, so no metadata is needed.
      return scrapeHrmDirectTenant(opts);
    case "schoolspring":
      // Single-tenant national K-12 board; the per-job company comes
      // from each list row's employer field, not the tenant record.
      return scrapeSchoolSpringTenant(opts);
    case "isolvedhire":
      // Slug-only tenancy: the board host is `{slug}.isolvedhire.com`; the
      // per-tenant domain_id is discovered from the board page itself, so
      // no metadata is needed.
      return scrapeIsolvedhireTenant(opts);
    case "applitrack":
      // Slug-only tenancy: the district board lives under
      // `www.applitrack.com/{slug}/onlineapp/` and one Output.asp GET
      // carries every posting, so no metadata is needed.
      return scrapeApplitrackTenant(opts);
    case "hiringthing":
      // Slug-only tenancy: the board host is `{slug}.hiringthing.com` and
      // the /api/rss.xml feed carries every role, so no metadata is needed.
      return scrapeHiringthingTenant(opts);
    case "apploi": {
      // Apploi scopes a tenant by the verbatim `brand` name string the
      // shared search API filters on — not URL-derivable, so it is
      // mandatory seed metadata. Brand missing → dead, same as phenom's
      // missing host.
      const brand = opts.tenant.metadata?.["brand"];
      if (brand === undefined) {
        return Promise.resolve({
          jobs: [],
          result: {
            slug: opts.tenant.slug,
            status: "dead",
            error: "apploi tenant missing metadata.brand",
            jobs_count: 0,
          },
        });
      }
      return scrapeApploiTenant({ ...opts, brand });
    }
    case "taleotbe": {
      // Taleo Business Edition. Tenant identity is the composite
      // (host, instance, cws) plus the org code as slug: the pod host
      // (`phh.tbe.taleo.net`), the pod instance path segment (`phh03`)
      // and the career-website selector (`37`). None of the three is
      // slug-derivable, so a tenant missing any of them is marked dead —
      // same convention as workday's host/site and oraclecloud's
      // host/site.
      const host = opts.tenant.metadata?.["host"];
      const instance = opts.tenant.metadata?.["instance"];
      const cws = opts.tenant.metadata?.["cws"];
      if (host === undefined || instance === undefined || cws === undefined) {
        return Promise.resolve({
          jobs: [],
          result: {
            slug: opts.tenant.slug,
            status: "dead",
            error: "taleotbe tenant missing metadata.host, metadata.instance or metadata.cws",
            jobs_count: 0,
          },
        });
      }
      return scrapeTaleoTbeTenant({ ...opts, host, instance, cws });
    }
    case "workstream": {
      // Workstream boards live on the shared host www.workstream.us at
      // `/j/{companyId}/{slug}/positions`. The 8-hex company id is routing
      // metadata the slug cannot derive, so it is mandatory — a tenant
      // missing it is marked dead, same convention as workday's host.
      const companyId = opts.tenant.metadata?.["company_id"];
      if (companyId === undefined) {
        return Promise.resolve({
          jobs: [],
          result: {
            slug: opts.tenant.slug,
            status: "dead",
            error: "workstream tenant missing metadata.company_id",
            jobs_count: 0,
          },
        });
      }
      return scrapeWorkstreamTenant({ ...opts, companyId });
    }
    case "hirebridge":
      // cid-only tenancy: the shared host recruit.hirebridge.com selects the
      // board by the numeric cid (= the tenant slug), and the single listing
      // page carries every role, so no metadata is needed.
      return scrapeHirebridgeTenant(opts);
    case "careerplug":
      // Slug-only tenancy: the board host is `{slug}.careerplug.com` and the
      // listing's pagination nav drives the page walk, so no metadata is needed.
      return scrapeCareerplugTenant(opts);
    case "jibeapply":
      // Slug-only tenancy with an optional vanity-host override: the board
      // defaults to `{slug}.jibeapply.com`, but a few customers serve the
      // identical API from a branded CNAME captured as metadata.host
      // (SSRF-guarded in the adapter, like phenom's vanity domains).
      return dispatchJibeapply(opts);
    case "hireology":
      // Slug-only tenancy: the public API is
      // `api.hireology.com/v2/public/careers/{slug}`, so no metadata is needed.
      return scrapeHireologyTenant(opts);
    case "applicantpool":
      // Slug-only tenancy: the board host is `{slug}.applicantpool.com`; the
      // per-tenant domain_id is discovered from the board page itself, so no
      // metadata is needed (same engine as isolvedhire, different host).
      return scrapeApplicantpoolTenant(opts);
    case "pageup": {
      // PageUp hosted boards. Tenant identity is the composite
      // (host, instance, clientkey) with the slug `{instance}-{clientkey}`:
      // the shared PageUp career host (`careers.pageuppeople.com`), the
      // numeric pod id (`438`) and the customer clientkey (`caw`). A clientkey
      // is not globally unique, so none of the three is slug-derivable and a
      // tenant missing any is marked dead — same convention as workday's
      // host/site and taleotbe's host/instance/cws.
      const host = opts.tenant.metadata?.["host"];
      const instance = opts.tenant.metadata?.["instance"];
      const clientKey = opts.tenant.metadata?.["clientkey"];
      if (host === undefined || instance === undefined || clientKey === undefined) {
        return Promise.resolve({
          jobs: [],
          result: {
            slug: opts.tenant.slug,
            status: "dead",
            error: "pageup tenant missing metadata.host, metadata.instance or metadata.clientkey",
            jobs_count: 0,
          },
        });
      }
      return scrapePageupTenant({ ...opts, host, instance, clientKey });
    }
    case "manatal":
      // Slug-only tenancy: the board is `www.careers-page.com/{slug}` and every
      // job URL is `.../{slug}/job/{code}`, so no metadata is needed.
      return scrapeManatalTenant(opts);
    case "rippling":
      // Slug-only tenancy: the public API is
      // `api.rippling.com/platform/api/ats/v1/board/{slug}/jobs`, so no
      // metadata is needed. The list carries no date/description, so the
      // adapter fans out a bounded detail GET per role to enrich them.
      return scrapeRipplingTenant(opts);
    case "jobscore":
      // Slug-only tenancy: the public feed is
      // `careers.jobscore.com/jobs/{slug}/feed.json`, which returns the whole
      // open-role list in one call, so no metadata is needed.
      return scrapeJobscoreTenant(opts);
    case "talentbrew": {
      // TalentBrew (Radancy) per-brand career sites. Each brand runs on its
      // own vanity host; the listing lives at `{host}/search-jobs`. The host
      // is not slug-derivable, so `metadata.host` is mandatory and
      // SSRF-guarded in the adapter (like phenom's vanity domains). Host
      // missing → dead, same convention as phenom/workday.
      const host = opts.tenant.metadata?.["host"];
      if (host === undefined) {
        return Promise.resolve({
          jobs: [],
          result: {
            slug: opts.tenant.slug,
            status: "dead",
            error: "talentbrew tenant missing metadata.host",
            jobs_count: 0,
          },
        });
      }
      return scrapeTalentbrewTenant({ ...opts, host });
    }
    case "paycom":
      // Slug-only tenancy: the slug is the 32-hex clientkey. The career page
      // (`.../portal/{CLIENTKEY}/career-page`) hands out the per-tenant JWT +
      // API base, so no metadata is needed. The list search carries no
      // location/salary/date, so the adapter fans out a bounded detail GET
      // per role to enrich them.
      return scrapePaycomTenant(opts);
  }
}
