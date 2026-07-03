import type { ATSId, Tenant, TenantStatus } from "@openroles/shared";
import pLimit from "p-limit";
import {
  assertOracleHost,
  assertOracleSite,
  assertPageupClientKey,
  assertPageupHost,
  assertPageupInstance,
  assertTaleoTbeCws,
  assertTaleoTbeHost,
  assertTaleoTbeInstance,
  assertWorkdayHost,
  assertWorkdaySite,
  isSafeFetchHost,
} from "../ats/common.ts";
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
  // Taleo enterprise career sites live under `{tenant}.taleo.net`; the
  // careersection root returns 200 on a live tenant. The TBE pool is a
  // separate ATS (`taleotbe`) with composite metadata — see
  // PROBE_URL_META below.
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
  // JazzHR hosted boards: the public board is `{slug}.applytojob.com/apply/`
  // (200 on a live tenant; a nonexistent slug fails DNS → dead).
  jazzhr: (slug) => `https://${slug}.applytojob.com/apply/`,
  // HRMDirect (ClearCompany): the job-openings listing is the public signal
  // (200 on a live tenant; nonexistent subdomain fails DNS → dead).
  hrmdirect: (slug) => `https://${slug}.hrmdirect.com/employment/job-openings.php`,
  // SchoolSpring is single-tenant, so the probe URL is fixed. The count
  // endpoint is the cheapest authentication-free signal: a tiny JSON
  // envelope (`{ success, value: <int> }`) instead of a job page.
  schoolspring: () =>
    "https://api.schoolspring.com/api/Jobs/GetJobsCountWithSearch?keyword=&location=&category=&gradelevel=&jobtype=&organization=",
  // isolved Hire hosted boards: the public board page is the probe. Unknown
  // subdomains 302-redirect on the SAME host to a `/notset.php` placeholder
  // (so cross-host redirect detection doesn't apply); the scraper still
  // classifies those tenants dead because the placeholder page carries no
  // `courierCurrentRouteData` domain_id.
  isolvedhire: (slug) => `https://${slug}.isolvedhire.com/jobs/`,
  // Frontline AppliTrack: the Output.asp posting stream itself is the
  // cheapest reliable signal — the shared host answers 200 for a live
  // district and an honest 404 for an unknown path slug (verified live:
  // no redirect-to-marketing dance, so no REDIRECT_HOST_MEANS_DEAD entry).
  applitrack: (slug) => `https://www.applitrack.com/${slug}/onlineapp/jobpostings/Output.asp?all=1`,
  // HiringThing hosted boards: the /api/rss.xml feed is the public signal
  // (200 on a live tenant, even with an empty channel; an unknown
  // subdomain 302-bounces to the vendor's www marketing site → dead).
  hiringthing: (slug) => `https://${slug}.hiringthing.com/api/rss.xml`,
  // Hirebridge: every board shares recruit.hirebridge.com, selected by a
  // numeric cid (= the tenant slug). The listing page is the public
  // signal: a live cid answers 200 directly, an unknown cid answers a
  // same-host 302 to the vendor error page (see REDIRECT_PATH_MEANS_DEAD).
  hirebridge: (slug) => `https://recruit.hirebridge.com/v3/jobs/list.aspx?cid=${slug}`,
  // CareerPlug: the paginated /jobs listing is the public signal (200 on a
  // live tenant; nonexistent subdomain fails DNS → dead).
  careerplug: (slug) => `https://${slug}.careerplug.com/jobs`,
  // Jibe hosted boards: a limit=1 listing call is the cheapest 200 on a
  // live tenant (the same endpoint the scraper pages through). Vanity-CNAME
  // tenants are operator-seeded and their default-host probe still answers.
  jibeapply: (slug) => `https://${slug}.jibeapply.com/api/jobs?page=1&limit=1`,
  // Hireology: the public careers API is the signal (200 + job JSON on a
  // live tenant, 404 on an unknown slug — verified live); page_size=1
  // keeps the probe cheap.
  hireology: (slug) => `https://api.hireology.com/v2/public/careers/${slug}?page=1&page_size=1`,
  // ApplicantPool hosted boards: the public board page is the probe. Unknown
  // subdomains 302-redirect on the SAME host to a placeholder (so cross-host
  // redirect detection doesn't apply); the scraper still classifies those
  // tenants dead because the placeholder carries no `courierCurrentRouteData`
  // domain_id (same engine + convention as isolvedhire).
  applicantpool: (slug) => `https://${slug}.applicantpool.com/jobs/`,
  // workday + ultipro + successfactors + oraclecloud + phenom need composite
  // metadata (host/site, board_id, locale) — see probeUrlForWithMetadata below.
  // workday + ultipro + successfactors + oraclecloud + phenom + taleotbe
  // need composite metadata (host/site, board_id, locale,
  // host/instance/cws) — see probeUrlForWithMetadata below.
};

// ATSes whose dead tenants answer a probe with a *cross-host* redirect to a
// generic landing page rather than an honest 4xx. JazzHR's `*.applytojob.com`
// 302-redirects unknown subdomains to `info.jazzhr.com/job-seekers.html`
// (HTTP 200), so a plain follow-redirect probe would mark every dead board
// `live`. For these ATSes we probe with `redirect: "manual"` and read the
// `Location` ourselves: a redirect that leaves the tenant's own host is dead,
// while a *same-host* redirect is a live board normalizing its own URL (e.g.
// hrmdirect appends a default `?cust_sort1=...` category sort) and stays live.
// A direct 2xx is always live.
const REDIRECT_HOST_MEANS_DEAD: Partial<Record<ATSId, true>> = {
  jazzhr: true,
  hrmdirect: true,
  // Unknown `*.hiringthing.com` subdomains answer /api/rss.xml with a
  // 302 to `www.hiringthing.com` (the vendor marketing site), which
  // itself serves 403 — only the cross-host bounce is the dead signal.
  hiringthing: true,
};

// Composite-metadata ATSes whose live board answers the probe URL with a
// direct 2xx and whose dead tenant instead 302-redirects (on any host). For
// these the metadata-probe path runs `redirect: "manual"` and treats a 3xx as
// dead — the redirect target itself serves 200, so following it would mark
// every dead board live. PageUp is the first: a dead clientkey bounces
// same-host to the pod's default board.
const DEAD_ON_REDIRECT_META: Partial<Record<ATSId, true>> = {
  pageup: true,
};

// ATSes whose dead tenants answer a probe with a *same-host* redirect to a
// shared vendor error page — a cross-host check can't see it. When the
// probed ATS has an entry here, the probe also runs with
// `redirect: "manual"` and a 3xx whose Location matches the pattern is
// dead; any other redirect stays live (same defensive posture as the
// cross-host rule: only a provably-dead shape drops the tenant).
const REDIRECT_PATH_MEANS_DEAD: Partial<Record<ATSId, RegExp>> = {
  // Hirebridge bounces an unknown cid from the listing to
  // `/v3/Application/AppErrMsg.aspx?cid={cid}&errorType=badurl`, which then
  // serves HTTP 200 — so following the redirect would mark every dead cid
  // live. Live cids answer the listing with a direct 200.
  hirebridge: /\/AppErrMsg\.aspx/i,
};

// True when `location` (resolved against the probe URL) points at a different
// host than the probe itself. An unparseable or missing Location is treated as
// not-cross-host so we keep the tenant `live` rather than dropping it on a
// malformed redirect — a later reprobe or scrape will reclassify if needed.
function redirectsToDifferentHost(probeUrl: string, location: string | null): boolean {
  if (location === null || location.length === 0) return false;
  try {
    return new URL(location, probeUrl).host !== new URL(probeUrl).host;
  } catch {
    return false;
  }
}

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
  oraclecloud: (_slug, metadata) => {
    // Oracle Fusion HCM Candidate Experience tenants are addressed by the
    // (host, site) composite. Both are mandatory and validated for SSRF /
    // injection exactly as the adapter does; a record missing either stays
    // transient_failure. A limit=1 requisitions call is the cheapest 200.
    const host = metadata["host"];
    const site = metadata["site"];
    if (typeof host !== "string" || typeof site !== "string") return undefined;
    try {
      assertOracleHost(host);
      assertOracleSite(site);
    } catch {
      return undefined;
    }
    return `https://${host}/hcmRestApi/resources/latest/recruitingCEJobRequisitions?onlyData=true&expand=requisitionList&finder=findReqs;siteNumber=${site},limit=1,sortBy=POSTING_DATES_DESC`;
  },
  apploi: (_slug, metadata) => {
    // Apploi tenants are addressed by the verbatim `brand` name string on
    // the shared search host. A size=1 brand query is the cheapest 200 and
    // a strict prefix of the scrape flow; the brand is URL-encoded, and
    // the same shape rules the adapter enforces (non-empty, no control
    // characters, ≤256 chars) apply here so a malformed record stays
    // transient rather than emitting a bad request.
    const brand = metadata["brand"];
    if (typeof brand !== "string" || brand.trim().length === 0) return undefined;
    // biome-ignore lint/suspicious/noControlCharactersInRegex: rejects control chars in an operator-seeded query value
    if (brand.length > 256 || /[\x00-\x1f\x7f]/.test(brand)) return undefined;
    return `https://ats-integrations.apploi.com/search/jobs/?page=1&size=1&brand=${encodeURIComponent(brand)}`;
  },
  taleotbe: (slug, metadata) => {
    // Taleo Business Edition tenants are addressed by the composite
    // (host, instance, cws) plus the org code (the slug). All three
    // metadata keys are mandatory and validated exactly as the adapter
    // does; a record missing any stays transient_failure until harvest
    // (or an operator) completes the composite. The v2 searchResults
    // page is the public board itself — 200 for a live org, a redirect
    // chain into an error page otherwise.
    const host = metadata["host"];
    const instance = metadata["instance"];
    const cws = metadata["cws"];
    if (typeof host !== "string" || typeof instance !== "string" || typeof cws !== "string") {
      return undefined;
    }
    try {
      assertTaleoTbeHost(host);
      assertTaleoTbeInstance(instance);
      assertTaleoTbeCws(cws);
    } catch {
      return undefined;
    }
    return `https://${host}/${instance}/ats/careers/v2/searchResults?org=${slug}&cws=${cws}`;
  },
  pageup: (_slug, metadata) => {
    // PageUp boards are addressed by the composite (host, instance,
    // clientkey). All three are mandatory and validated exactly as the
    // adapter does; a record missing any stays transient_failure until
    // harvest (or an operator) completes the composite. The listing page is
    // the public board itself: a live board answers a direct 200, while a
    // dead clientkey 302-redirects (same host) to the pod's default board —
    // so the probe runs redirect:manual and treats any 3xx as dead (see
    // DEAD_ON_REDIRECT below).
    const host = metadata["host"];
    const instance = metadata["instance"];
    const clientKey = metadata["clientkey"];
    if (typeof host !== "string" || typeof instance !== "string" || typeof clientKey !== "string") {
      return undefined;
    }
    try {
      assertPageupHost(host);
      assertPageupInstance(instance);
      assertPageupClientKey(clientKey);
    } catch {
      return undefined;
    }
    return `https://${host}/${instance}/${clientKey}/en/listing/`;
  },
  phenom: (_slug, metadata) => {
    // Phenom career sites are addressed by (host, locale). The host is a
    // (often vanity) careers domain, SSRF-guarded the same way the adapter
    // does; locale (the `{country}/{lang}` segment) defaults to us/en. The
    // search-results page returns 200 for a live tenant.
    const host = metadata["host"];
    if (typeof host !== "string" || host.length === 0) return undefined;
    const locale = metadata["locale"] ?? "us/en";
    if (!/^[a-z]{2,8}\/[a-z]{2}$/.test(locale)) return undefined;
    if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?\.)+[a-z]{2,}$/i.test(host)) return undefined;
    let parsed: URL;
    try {
      parsed = new URL(`https://${host}`);
      /* c8 ignore next 3 — host already passed the strict DNS-label regex above, so new URL cannot throw here. */
    } catch {
      return undefined;
    }
    if (parsed.hostname !== host.toLowerCase() || !isSafeFetchHost(parsed)) return undefined;
    return `https://${host}/${locale}/search-results`;
  },
  workstream: (slug, metadata) => {
    // Workstream boards are addressed by the composite (company_id, slug)
    // on the shared host www.workstream.us. The 8-hex company id is
    // mandatory and validated for shape before it flows into the URL; a
    // record missing it stays transient_failure (same convention as
    // workday/ultipro). The positions listing is the public signal: a live
    // board answers 200 (even with zero roles), a dead/unknown pair
    // answers 410 Gone.
    const companyId = metadata["company_id"];
    if (typeof companyId !== "string" || !/^[0-9a-f]{8}$/.test(companyId)) return undefined;
    return `https://www.workstream.us/j/${companyId}/${slug}/positions`;
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
// Most per-subdomain ATSes (bamboohr, icims, etc.) hit a unique host per
// probe, so they're not capped here — each can run at the caller-supplied
// concurrency.
//
// breezy is the exception: despite addressing tenants per-subdomain
// (`{slug}.breezy.hr`), breezy.hr enforces a shared rate limit across all
// subdomains. A full-corpus reprobe burst got the prober IP blocked (every
// subsequent probe failed → tenants mis-marked dead), so it's capped and
// delayed like a shared-host ATS.
//
// Workday is per-tenant-host but uses the same operator's CDN
// (workday.com) for all of them, so caps similarly to shared-host
// ATSes despite the host varying per-tenant.
const PROBE_HOST_CONCURRENCY: Partial<Record<ATSId, number>> = {
  workable: 1,
  // Every applitrack probe hits the one shared host www.applitrack.com.
  applitrack: 2,
  breezy: 2,
  jobvite: 2,
  smartrecruiters: 2,
  ultipro: 2,
  // Every workstream tenant probe hits the single shared host
  // www.workstream.us, so it caps like the other shared-host ATSes.
  workstream: 2,
  greenhouse: 3,
  lever: 3,
  ashby: 3,
  workday: 4,
  // recruit.hirebridge.com is one shared origin for every tenant probe.
  hirebridge: 2,
};

// Inter-probe delay (ms) injected before every probe of a shared-host
// ATS. Smooths bursts so a freshly-warmed pLimit doesn't fire 3-4
// simultaneous requests at the same host. Combines with the hard
// concurrency cap above.
const PROBE_HOST_DELAY_MS: Partial<Record<ATSId, number>> = {
  workable: 800,
  applitrack: 200,
  // breezy.hr rate-limits across all subdomains (see PROBE_HOST_CONCURRENCY);
  // ~2.5 probes/s was observed safe, so 700ms × 2-concurrent stays under it.
  breezy: 700,
  jobvite: 200,
  smartrecruiters: 200,
  ultipro: 200,
  workstream: 200,
  greenhouse: 100,
  lever: 100,
  ashby: 100,
  hirebridge: 200,
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
    const deadOnRedirect = DEAD_ON_REDIRECT_META[ats] === true;
    try {
      const res = await client.request(url, {
        method: shape.method,
        skipRobots: true,
        ...(deadOnRedirect ? { redirect: "manual" as const } : {}),
        ...(shape.body !== undefined ? { body: shape.body } : {}),
        ...(shape.headers !== undefined ? { headers: shape.headers } : {}),
      });
      // A live board answers the listing with a direct 2xx; a dead clientkey
      // 302s to the pod's default board (which serves 200), so a redirect
      // here is the honest dead signal.
      if (deadOnRedirect && res.status >= 300 && res.status < 400) {
        const result: Tenant = { ats, slug, status: "dead", last_probed_at: observedAt };
        return metadata ? { ...result, metadata } : result;
      }
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
    const probeUrl = probeUrlFor(ats, slug);
    const redirectHostMeansDead = REDIRECT_HOST_MEANS_DEAD[ats] === true;
    const deadRedirectPath = REDIRECT_PATH_MEANS_DEAD[ats];
    const inspectRedirects = redirectHostMeansDead || deadRedirectPath !== undefined;
    const res = await client.request(probeUrl, {
      method: "GET",
      skipRobots: true,
      ...(inspectRedirects ? { redirect: "manual" as const } : {}),
    });
    // For these ATSes, a dead board answers with a redirect: either a
    // cross-host bounce to a generic vendor page (jazzhr/hrmdirect) or a
    // same-host bounce to the vendor error page (hirebridge). A same-host
    // redirect that isn't the error page is a live board normalizing its
    // own URL, and a direct 2xx is a live board.
    if (inspectRedirects && res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (redirectHostMeansDead && redirectsToDifferentHost(probeUrl, location)) {
        return { ats, slug, status: "dead", last_probed_at: observedAt };
      }
      if (deadRedirectPath !== undefined && location !== null && deadRedirectPath.test(location)) {
        return { ats, slug, status: "dead", last_probed_at: observedAt };
      }
    }
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
