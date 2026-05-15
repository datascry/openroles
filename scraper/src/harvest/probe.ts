import type { ATSId, Tenant, TenantStatus } from "@openroles/shared";
import pLimit from "p-limit";
import { assertWorkdayHost, assertWorkdaySite, isSafeFetchHost } from "../ats/common.ts";
import { fetchWorkdaySite } from "../ats/workday-site-fetch.ts";
import { type HttpClient, HttpError } from "../http.ts";

export type ProbeUrlBuilder = (slug: string) => string;

// Probe URL builders that use only the slug — covers most ATSes.
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
  // Factorial's tenant landing page returns 200 even for tenants with no
  // published careers page. The sitemap is the actual public job feed —
  // tenants without one return 404 here.
  factorial: (slug) => `https://${slug}.factorialhr.com/sitemap.xml`,
  // Eightfold's `/careers` page returns the same HTML shell for every slug
  // (the tenant-specific data loads via API behind PCSX auth). The careers
  // sitemap is the actual public signal — tenants with no published jobs
  // return 404 here.
  eightfold: (slug) => `https://${slug}.eightfold.ai/careers/sitemap.xml`,
  // Phase-6 custom ATSes: each is single-tenant, so the probe URL is
  // fixed. We use the GET-friendly public landing page (HTML or JSON
  // GET) rather than the POST-only API endpoint the scraper hits;
  // probe is a liveness check, not a representative call.
  amazonjobs: () => "https://amazon.jobs/en/search.json?result_limit=1",
  applejobs: () => "https://jobs.apple.com/",
  tiktokcareers: () => "https://careers.tiktok.com/",
  metacareers: () => "https://www.metacareers.com/jobs/",
  // workday + ultipro + successfactors need composite metadata
  // (host/site, board_id) — see probeUrlForWithMetadata below.
};

// Probe URL builders that need both slug and metadata (workday, ultipro).
// These return undefined when the metadata bag is missing the required keys.
type ProbeUrlMetaBuilder = (slug: string, metadata: Record<string, string>) => string | undefined;

const PROBE_URL_META: Partial<Record<ATSId, ProbeUrlMetaBuilder>> = {
  workday: (_slug, metadata) => {
    const host = metadata["host"];
    if (typeof host !== "string" || host.length === 0) return undefined;
    // Default to "External" when site is missing — that's the canonical
    // public-facing site name across the workday ecosystem (most tenants
    // expose `External`, a few use `Careers` or other custom names).
    // The S3 bootstrap captured `host` for ~all 4,295 tenants but only
    // 44 had `site` from CDX (most CDX URLs are bare host pages, not
    // `/<site>` deep links). Falling back here unlocks the other 98%.
    const site = metadata["site"] ?? "External";
    // Defensive — these strings flow into URLs, validate the shape we
    // observed in CDX before sending the network request.
    try {
      assertWorkdayHost(host);
      assertWorkdaySite(site);
    } catch {
      return undefined;
    }
    // Probe via the user-facing /<site> URL (GET, returns 200 on a
    // tenant whose site exists). The previously-used cxs/jobs API
    // requires POST with a specific JSON body and returns 422 on
    // validation gaps; HttpClient classifies 422 as permanent → dead,
    // so a working tenant looked dead. The /<site> path returns 200
    // when the site is real (not just the slug) and 404 otherwise.
    return `https://${host}/${site}`;
  },
  ultipro: (slug, metadata) => {
    const boardId = metadata["board_id"];
    if (typeof boardId !== "string" || boardId.length === 0) return undefined;
    if (!/^[0-9a-f-]{32,40}$/i.test(boardId)) return undefined;
    // Tenant codes are uppercased on the public URL — we lowercase on
    // harvest to round-trip through SLUG_PATTERN, then uppercase here.
    return `https://recruiting.ultipro.com/${slug.toUpperCase()}/JobBoard/${boardId}/JobBoardView/LoadSearchResults`;
  },
  successfactors: (slug, metadata) => {
    // SuccessFactors tenants are addressed by `company={slug}` on a
    // regional datacenter (`career{N}.successfactors.{tld}`). The host
    // is non-derivable from the slug, so harvest must capture it; a
    // tenant record without `metadata.host` stays at transient_failure
    // until a later harvest pass surfaces the regional cluster
    // (mirrors the workday/ultipro convention).
    const host = metadata["host"];
    if (typeof host !== "string" || host.length === 0) return undefined;
    if (!/^career[0-9]{1,3}\.successfactors\.(?:com|eu|de|com\.cn|fr|co\.uk)$/.test(host)) {
      return undefined;
    }
    // Customer-facing search page (HTML); 200 means SF acknowledges
    // the company identifier, 404 means it doesn't.
    return `https://${host}/career?company=${encodeURIComponent(slug)}`;
  },
  brassring: (_slug, metadata) => {
    // BrassRing tenants are addressed by (partnerid, siteid) on the
    // shared host sjobs.brassring.com. Both IDs are numeric strings;
    // anything else is a template-injection signal and gets rejected
    // by the adapter's own assertBrassringIds — same regex enforced
    // here so the probe URL builder fails fast.
    const partnerId = metadata["partnerid"];
    const siteId = metadata["siteid"];
    if (typeof partnerId !== "string" || !/^[0-9]{1,9}$/.test(partnerId)) return undefined;
    if (typeof siteId !== "string" || !/^[0-9]{1,9}$/.test(siteId)) return undefined;
    // Probe the home page — 200 means the tenant exists. The home page
    // also serves the RFT token and session cookies the scrape path
    // needs, so this probe is a strict prefix of the scrape flow.
    return `https://sjobs.brassring.com/TGNewUI/Search/Home/Home?partnerid=${partnerId}&siteid=${siteId}`;
  },
  jsonld: (_slug, metadata) => {
    // The jsonld harvester is vendor-agnostic: the sitemap URL itself
    // is the probe target. 200 + XML content means a live sitemap; a
    // missing or invalid sitemap_url short-circuits to transient.
    const sitemapUrl = metadata["sitemap_url"];
    if (typeof sitemapUrl !== "string" || sitemapUrl.length === 0) return undefined;
    // Defence in depth: only allow https URLs, no loopback / private /
    // metadata-IP exfil targets. Shared with the scrape path via
    // isSafeFetchHost so both surfaces apply the same rejection rules
    // (audit M-2 fix: the previous version of this builder enforced
    // these rules but scrapeJsonldTenant did not).
    let parsed: URL;
    try {
      parsed = new URL(sitemapUrl);
    } catch {
      return undefined;
    }
    if (!isSafeFetchHost(parsed)) return undefined;
    return sitemapUrl;
  },
  gjobsfeed: (_slug, metadata) => {
    // Vendor-agnostic Google-for-Jobs RSS feed harvester: the feed URL
    // itself is the probe target. 200 + RSS content means a live feed;
    // a missing or invalid feed_url short-circuits to transient. Same
    // SSRF guard as jsonld (https only, no loopback / private /
    // metadata-IP exfil targets) so probe + scrape share the rule.
    const feedUrl = metadata["feed_url"];
    if (typeof feedUrl !== "string" || feedUrl.length === 0) return undefined;
    let parsed: URL;
    try {
      parsed = new URL(feedUrl);
    } catch {
      return undefined;
    }
    if (!isSafeFetchHost(parsed)) return undefined;
    return feedUrl;
  },
};

export function probeUrlFor(ats: ATSId, slug: string): string {
  const build = PROBE_URL[ats];
  if (!build) throw new Error(`probe URL not defined for ats ${ats}`);
  return build(slug);
}

// Composite-metadata variant: returns undefined for ATSes that don't need
// metadata, the URL string when the metadata is sufficient to compose a
// probe URL, and undefined when the metadata bag is missing keys (caller
// should treat that as transient_failure).
export function probeUrlForWithMetadata(
  ats: ATSId,
  slug: string,
  metadata: Record<string, string> | undefined,
): string | undefined {
  const build = PROBE_URL_META[ats];
  if (!build) return undefined;
  return build(slug, metadata ?? {});
}

interface ProbeRequestShape {
  readonly method: "GET" | "POST";
  readonly body?: string;
  readonly headers?: Record<string, string>;
}

// Some composite-metadata ATSes need a non-GET probe (ultipro's
// `LoadSearchResults` endpoint is POST + JSON body; GET returns 415).
// Workday uses GET against the user-facing /<site> URL — see
// PROBE_URL_META.workday — so it doesn't need an entry here.
const PROBE_REQUEST_SHAPE: Partial<Record<ATSId, ProbeRequestShape>> = {
  ultipro: {
    method: "POST",
    body: "{}",
    headers: { "content-type": "application/json", accept: "application/json" },
  },
};

export interface ProbeOptions {
  readonly client: HttpClient;
  readonly observedAt: string;
  readonly concurrency?: number;
  // Optional metadata hint per slug — used by workday / ultipro whose probe
  // URL needs more than the slug to compose. Slugs without metadata in the
  // map fall back to transient_failure for those ATSes.
  readonly metadataBySlug?: ReadonlyMap<string, Record<string, string>>;
  // When true, re-discover workday `metadata.site` even when already set.
  // Default false: site labels almost never change, so the weekly reprobe
  // pass should skip tenants that already have one. Operators force a
  // rediscovery via `reprobe --force-rediscover` after a known mass
  // rename (rare).
  readonly forceRediscover?: boolean;
}

const DEFAULT_PROBE_CONCURRENCY = 6;
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

// Per-ATS hard cap on probe concurrency. Shared-host ATSes (workable's
// `apply.workable.com`, jobvite's `jobs.jobvite.com`, smartrecruiters'
// `api.smartrecruiters.com`, ultipro's `recruiting.ultipro.com`,
// greenhouse's `boards-api.greenhouse.io`, lever's `api.lever.co`,
// ashby's `api.ashbyhq.com`) put every tenant probe behind one host
// — running 6 concurrent probes is a CDN-rate-limit invitation that
// triggered Cloudflare to IP-ban us mid-bootstrap (workable returned
// 429 to every subsequent request for hours).
//
// Per-subdomain ATSes (bamboohr, breezy, icims, etc.) hit a unique
// host per probe, so they're not capped here — each can run at the
// caller-supplied concurrency.
//
// Workday is per-tenant-host but uses the same operator's CDN
// (workday.com) for all of them, so caps similarly to shared-host
// ATSes despite the host varying per-tenant.
const PROBE_HOST_CONCURRENCY: Partial<Record<ATSId, number>> = {
  workable: 1,
  jobvite: 2,
  smartrecruiters: 2,
  ultipro: 2,
  greenhouse: 3,
  lever: 3,
  ashby: 3,
  workday: 4,
};

// Inter-probe delay (ms) injected before every probe of a shared-host
// ATS. Smooths bursts so a freshly-warmed pLimit doesn't fire 3-4
// simultaneous requests at the same host. Combines with the hard
// concurrency cap above.
const PROBE_HOST_DELAY_MS: Partial<Record<ATSId, number>> = {
  workable: 800,
  jobvite: 200,
  smartrecruiters: 200,
  ultipro: 200,
  greenhouse: 100,
  lever: 100,
  ashby: 100,
};

// Hard ceiling on how long a single probe may take before we declare it
// `transient_failure` and let probeMany advance. HttpClient already has
// a 30s AbortSignal.timeout, but Bun's fetch has documented edge cases
// where TLS-handshake or DNS-resolution hangs evade the abort and leave
// the promise unsettled — observed in production: a workable reprobe of
// 14k tenants stalled for 80+ minutes with 0% CPU and zero open sockets.
// One unsettled promise blocks a pLimit slot, eventually all 6 slots
// fill, and the whole batch deadlocks. This wrapper guarantees forward
// progress regardless of fetch internals.
const HARD_PROBE_TIMEOUT_MS = 45_000;

async function withHardTimeout<T>(work: Promise<T>, fallback: T, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  try {
    return await Promise.race([work, guard]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function probeOne(
  ats: ATSId,
  slug: string,
  client: HttpClient,
  observedAt: string,
  metadata?: Record<string, string>,
  forceRediscover?: boolean,
): Promise<Tenant> {
  // Hard-timeout the entire probe attempt. See HARD_PROBE_TIMEOUT_MS.
  const fallback: Tenant = { ats, slug, status: "transient_failure", last_probed_at: observedAt };
  return await withHardTimeout(
    probeOneInner(ats, slug, client, observedAt, metadata, forceRediscover ?? false),
    metadata ? { ...fallback, metadata } : fallback,
    HARD_PROBE_TIMEOUT_MS,
  );
}

/**
 * Augment the `metadata` of a tenant that just probed `live` with any
 * per-ATS lookups that are cheap enough to bundle into the probe pass.
 * Currently: workday's `site` label (auto-discovered from /robots.txt).
 *
 * Empirically ~70% of workday tenants expose the label cleanly via
 * robots.txt; the remaining ~30% have an empty body and stay on the
 * scraper's hardcoded External / Careers / External_Career_Site /
 * External_Site fallback chain. We skip the lookup when a site is
 * already set (labels almost never change), unless `forceRediscover`
 * is set after a known mass rename.
 */
async function augmentLiveMetadata(
  ats: ATSId,
  metadata: Record<string, string>,
  client: HttpClient,
  forceRediscover: boolean,
): Promise<Record<string, string>> {
  const out: Record<string, string> = { ...metadata };
  if (ats !== "workday") return out;
  const host = out["host"];
  if (host === undefined) return out;
  if (out["site"] !== undefined && !forceRediscover) return out;
  const discovered = await fetchWorkdaySite(host, client);
  if (discovered !== null) out["site"] = discovered;
  return out;
}

async function probeOneInner(
  ats: ATSId,
  slug: string,
  client: HttpClient,
  observedAt: string,
  metadata: Record<string, string> | undefined,
  forceRediscover: boolean,
): Promise<Tenant> {
  if (!SLUG_RE.test(slug)) {
    return { ats, slug, status: "dead", last_probed_at: observedAt };
  }
  // For ATSes whose probe URL needs composite metadata: if the harvester
  // captured it, build the URL and probe. If not, stay at transient_failure
  // — a future harvest pass that surfaces the missing metadata pivots us
  // out of that state without losing the slug.
  if (PROBE_URL_META[ats]) {
    const url = probeUrlForWithMetadata(ats, slug, metadata);
    if (!url) {
      const result: Tenant = {
        ats,
        slug,
        status: "transient_failure",
        last_probed_at: observedAt,
      };
      return metadata ? { ...result, metadata } : result;
    }
    const shape: ProbeRequestShape = PROBE_REQUEST_SHAPE[ats] ?? { method: "GET" };
    try {
      await client.request(url, {
        method: shape.method,
        skipRobots: true,
        ...(shape.body !== undefined ? { body: shape.body } : {}),
        ...(shape.headers !== undefined ? { headers: shape.headers } : {}),
      });
      const liveMetadata = await augmentLiveMetadata(ats, metadata ?? {}, client, forceRediscover);
      return { ats, slug, status: "live", last_probed_at: observedAt, metadata: liveMetadata };
    } catch (err) {
      const status: TenantStatus =
        err instanceof HttpError && err.kind === "transient" ? "transient_failure" : "dead";
      const result: Tenant = { ats, slug, status, last_probed_at: observedAt };
      return metadata ? { ...result, metadata } : result;
    }
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
      // Homerun's AWS ELB now blanket-403s every direct request to
      // `*.homerun.co` and `feed.homerun.co/*` regardless of headers
      // (anti-bot at the load-balancer level, fingerprints the TLS or
      // user-agent). Marking 1,780 tenants as `dead` based on that
      // would lose them all. Until a working homerun probe surfaces,
      // map their 403s to `transient_failure` so they survive in the
      // corpus pending an alternate signal.
      if (ats === "homerun" && err.status === 403) {
        return { ats, slug, status: "transient_failure", last_probed_at: observedAt };
      }
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
  // Effective concurrency = min(caller's request, ATS host cap).
  // Shared-host ATSes (workable, jobvite, etc.) cap aggressively to
  // avoid the CDN rate-limit / IP-ban scenario observed mid-bootstrap.
  const requestedConcurrency = opts.concurrency ?? DEFAULT_PROBE_CONCURRENCY;
  const hostCap = PROBE_HOST_CONCURRENCY[ats] ?? Number.POSITIVE_INFINITY;
  const effectiveConcurrency = Math.min(requestedConcurrency, hostCap);
  const limit = pLimit(effectiveConcurrency);
  // Optional per-ATS pre-probe delay — smooths bursts so a freshly
  // warmed pLimit doesn't fire concurrently against the same shared
  // host. No delay for per-subdomain ATSes (each probe is a different
  // host, so bursts don't pile on a single endpoint).
  const delayMs = PROBE_HOST_DELAY_MS[ats] ?? 0;
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  return Promise.all(
    slugs.map((slug) =>
      limit(async () => {
        if (delayMs > 0) await sleep(delayMs);
        return await probeOne(
          ats,
          slug,
          opts.client,
          opts.observedAt,
          opts.metadataBySlug?.get(slug),
          opts.forceRediscover,
        );
      }),
    ),
  );
}
