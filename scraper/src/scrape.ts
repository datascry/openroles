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
import { scrapeAshbyTenant } from "./ats/ashby.ts";
import { scrapeBambooTenant } from "./ats/bamboohr.ts";
import { scrapeBreezyTenant } from "./ats/breezy.ts";
import { scrapeGreenhouseTenant } from "./ats/greenhouse.ts";
import { scrapeIcimsTenant } from "./ats/icims.ts";
import { scrapeLeverTenant } from "./ats/lever.ts";
import { scrapePersonioTenant } from "./ats/personio.ts";
import { scrapeRecruiteeTenant } from "./ats/recruitee.ts";
import { scrapeWorkableTenant } from "./ats/workable.ts";
import { scrapeWorkdayTenant } from "./ats/workday.ts";
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
      const site = opts.tenant.metadata?.["site"];
      if (host === undefined || site === undefined) {
        return Promise.resolve({
          jobs: [],
          result: {
            slug: opts.tenant.slug,
            status: "dead",
            error: "workday tenant missing metadata.host or metadata.site",
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
    case "teamtailor":
    case "smartrecruiters":
    case "csod":
    case "taleo":
    case "ultipro":
    case "jobvite":
    case "zohorecruit":
    case "talentlyft":
    case "pinpointhq":
    case "applicantpro":
    case "applicantstack":
    case "homerun":
    case "factorial":
    case "eightfold":
      // Harvest patterns and probe URLs are wired (so tenant lists populate)
      // but the scraper modules are not yet implemented; the dispatcher
      // surfaces the gap as transient_failure rather than a thrown error.
      // Scrapers land progressively; tenants harvested today are already
      // available for the moment a scraper ships.
      return Promise.resolve({
        jobs: [],
        result: {
          slug: opts.tenant.slug,
          status: "transient_failure",
          error: `${ats} scraper not yet implemented`,
          jobs_count: 0,
        },
      });
  }
}
