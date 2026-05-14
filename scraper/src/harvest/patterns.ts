import type { ATSId } from "@openroles/shared";

export interface AtsHarvestPattern {
  readonly ats: ATSId;
  readonly cdxQuery: string;
  readonly regex: RegExp;
  readonly denyList: ReadonlySet<string>;
  // Some ATSes need more than a slug to compose a working job-board URL.
  // Workday's API URL is `{host}/wday/cxs/{tenant}/{site}/jobs` — the host
  // and site can't be inferred from the slug. Ultipro's is
  // `recruiting.ultipro.com/{tenant}/JobBoard/{guid}/Search`. When the
  // pattern's regex captures these extra groups, this hook converts a
  // RegExpExecArray into the metadata bag stored on the tenant record.
  // Returning undefined skips metadata for that match (the slug still
  // counts).
  readonly extractMetadata?: (match: RegExpExecArray) => Record<string, string> | undefined;
}

// Path-based ATSes (slug appears as a URL path segment): deny terms that look
// like reserved path words on the public board host.
const PATH_DENY: ReadonlySet<string> = new Set([
  "embed",
  "support",
  "help",
  "docs",
  "blog",
  "status",
  "auth",
  "login",
  "admin",
  "assets",
  "static",
  "cdn",
  "api",
  "app",
  "www",
]);

// Subdomain-based ATSes (slug appears as a DNS label): deny well-known
// non-tenant subdomains. Generic words like "embed" / "support" are NOT
// excluded here because real companies do use them as tenant slugs.
const SUBDOMAIN_DENY: ReadonlySet<string> = new Set([
  "www",
  "app",
  "api",
  "assets",
  "static",
  "cdn",
  "admin",
  "login",
  "auth",
]);

const HARVEST_PATTERNS: ReadonlyArray<AtsHarvestPattern> = [
  {
    ats: "greenhouse",
    cdxQuery: "boards.greenhouse.io/*",
    // The canonical /{slug} board URL is the only path Common Crawl ever
    // captures: greenhouse's robots.txt sets `Disallow: /embed/`, so iframe-
    // embed URLs (`/embed/job_app?for={slug}`) never appear in CDX results.
    regex: /boards\.greenhouse\.io\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)(?:[/?#]|$)/gi,
    denyList: PATH_DENY,
  },
  {
    ats: "lever",
    cdxQuery: "jobs.lever.co/*",
    regex: /jobs\.lever\.co\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)(?:[/?#]|$)/gi,
    denyList: PATH_DENY,
  },
  {
    ats: "ashby",
    cdxQuery: "jobs.ashbyhq.com/*",
    regex: /jobs\.ashbyhq\.com\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)(?:[/?#]|$)/gi,
    denyList: PATH_DENY,
  },
  {
    ats: "bamboohr",
    cdxQuery: "*.bamboohr.com/*",
    regex: /https?:\/\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\.bamboohr\.com\//gi,
    denyList: SUBDOMAIN_DENY,
  },
  {
    ats: "workday",
    // Capture (slug, host suffix, site). Three CDX URL surfaces all carry
    // the site code in different positions; a single regex with two
    // alternatives covers them:
    //   1. API pivot:  `{host}/wday/cxs/{tenant}/{site}/...`     → group 3
    //   2. User-facing: `{host}/{Site}` or `{host}/{tenant}/{Site}` → group 4
    //   3. Bare host:  `{host}/`                                 → no site
    //
    // The `i` flag is dropped (vs other patterns) because the user-facing
    // alternative needs `[A-Z]` to mean uppercase only — workday site
    // names start with a capital letter, and we use that to distinguish
    // them from path tokens like "job" or "external" in nested URLs.
    // CDX SURT URLs are lowercase so the host portion still matches.
    cdxQuery: "*.myworkdayjobs.com/*",
    regex:
      /https?:\/\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)(\.wd\d+(?:-[a-z0-9-]+)?\.myworkdayjobs\.com)(?:\/wday\/cxs\/[a-z0-9-]+\/([A-Za-z0-9_-]{1,64})|\/(?:[a-z0-9-]+\/)?([A-Z][A-Za-z0-9_-]{0,63})(?=\/|\?|$))?/g,
    denyList: SUBDOMAIN_DENY,
    extractMetadata: (match) => {
      const slug = match[1];
      const suffix = match[2];
      const site = match[3] ?? match[4];
      if (!slug || !suffix) return undefined;
      const host = `${slug}${suffix}`;
      return site && site.length > 0 ? { host, site } : { host };
    },
  },
  {
    ats: "icims",
    // CDX's prefix-match semantics on URL queries do not honor wildcards
    // inside a host segment (the SURT urlkey is rooted at the registrable
    // domain), so `careers-*.icims.com/*` never matches anything. The full
    // `*.icims.com/*` form does. Only ~57% of real iCIMS career sites use
    // the `careers-` subdomain prefix; the other 43% use varied prefixes
    // (`{branded}careers-{tenant}`, `{tenant1}-{tenant2}`, etc.), so the
    // tenant slug is the entire subdomain label rather than a stripped
    // suffix. The probe and scraper compose the URL as
    // `https://{slug}.icims.com/sitemap.xml`.
    cdxQuery: "*.icims.com/*",
    regex: /https?:\/\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\.icims\.com/gi,
    denyList: SUBDOMAIN_DENY,
  },
  {
    ats: "recruitee",
    cdxQuery: "*.recruitee.com/*",
    regex: /https?:\/\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\.recruitee\.com/gi,
    denyList: SUBDOMAIN_DENY,
  },
  {
    ats: "breezy",
    cdxQuery: "*.breezy.hr/*",
    regex: /https?:\/\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\.breezy\.hr/gi,
    denyList: SUBDOMAIN_DENY,
  },
  {
    ats: "personio",
    // Personio production career sites live under `{tenant}.jobs.personio.com`
    // (and a smaller `.de` mirror; the probe accepts either via the dedicated
    // probe URL builder).
    cdxQuery: "*.jobs.personio.com/*",
    regex: /https?:\/\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\.jobs\.personio\.com/gi,
    denyList: SUBDOMAIN_DENY,
  },
  {
    ats: "workable",
    // Two URL surfaces are both common: subdomain `{tenant}.workable.com`
    // and path-based `apply.workable.com/{tenant}`. The alternation covers
    // both so the regex ignores the route the URL happened to be linked from.
    cdxQuery: "*.workable.com/*",
    regex:
      /https?:\/\/(?:apply\.workable\.com\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)|([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\.workable\.com)/gi,
    denyList: SUBDOMAIN_DENY,
  },
  {
    ats: "teamtailor",
    cdxQuery: "*.teamtailor.com/*",
    regex: /https?:\/\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\.teamtailor\.com/gi,
    denyList: SUBDOMAIN_DENY,
  },
  {
    ats: "smartrecruiters",
    // Path-based slug under careers.smartrecruiters.com/{tenant}. The host
    // itself is constant; the company identifier is the first path segment.
    cdxQuery: "careers.smartrecruiters.com/*",
    regex: /careers\.smartrecruiters\.com\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)(?:[/?#]|$)/gi,
    denyList: PATH_DENY,
  },
  {
    ats: "csod",
    cdxQuery: "*.csod.com/*",
    regex: /https?:\/\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\.csod\.com/gi,
    denyList: SUBDOMAIN_DENY,
  },
  {
    ats: "taleo",
    // Two surface forms: bare `{tenant}.taleo.net/...` and the TBE pool
    // `{tenant}.tbe.taleo.net/...`. Both use the first label as the slug.
    cdxQuery: "*.taleo.net/*",
    regex: /https?:\/\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)(?:\.tbe)?\.taleo\.net/gi,
    denyList: SUBDOMAIN_DENY,
  },
  {
    ats: "ultipro",
    // Path-based: `recruiting.ultipro.com/{TENANT_CODE}/JobBoard/{guid}/...`.
    // The slug (group 1) is the first path segment — an uppercase
    // alphanumeric code (5-32 chars), lowercased on extraction so it
    // round-trips through the shared SLUG_PATTERN, then uppercased again
    // at probe/scrape URL time. The optional GUID (group 2) is the
    // per-board identifier UKG assigns to each career site; without it
    // the JobBoard URL 404s, so we capture and store it as
    // `metadata.board_id`. Bare landing pages
    // (`recruiting.ultipro.com/{TENANT}` with nothing else) leave group 2
    // empty; the slug still counts but the tenant stays at
    // transient_failure until a CDX entry surfaces the GUID.
    cdxQuery: "recruiting.ultipro.com/*",
    regex:
      /recruiting\.ultipro\.com\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)(?:\/JobBoard\/([0-9a-f-]{32,40}))?(?:[/?#]|$)/gi,
    denyList: PATH_DENY,
    extractMetadata: (match) => {
      const guid = match[2];
      if (typeof guid !== "string" || guid.length === 0) return undefined;
      return { board_id: guid };
    },
  },
  {
    ats: "jobvite",
    cdxQuery: "jobs.jobvite.com/*",
    regex: /jobs\.jobvite\.com\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)(?:[/?#]|$)/gi,
    denyList: PATH_DENY,
  },
  {
    ats: "zohorecruit",
    cdxQuery: "*.zohorecruit.com/*",
    regex: /https?:\/\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\.zohorecruit\.com/gi,
    denyList: SUBDOMAIN_DENY,
  },
  {
    ats: "talentlyft",
    cdxQuery: "*.talentlyft.com/*",
    regex: /https?:\/\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\.talentlyft\.com/gi,
    denyList: SUBDOMAIN_DENY,
  },
  {
    ats: "pinpointhq",
    cdxQuery: "*.pinpointhq.com/*",
    regex: /https?:\/\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\.pinpointhq\.com/gi,
    denyList: SUBDOMAIN_DENY,
  },
  {
    ats: "applicantpro",
    cdxQuery: "*.applicantpro.com/*",
    regex: /https?:\/\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\.applicantpro\.com/gi,
    denyList: SUBDOMAIN_DENY,
  },
  {
    ats: "applicantstack",
    cdxQuery: "*.applicantstack.com/*",
    regex: /https?:\/\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\.applicantstack\.com/gi,
    denyList: SUBDOMAIN_DENY,
  },
  {
    ats: "homerun",
    cdxQuery: "*.homerun.co/*",
    regex: /https?:\/\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\.homerun\.co/gi,
    denyList: SUBDOMAIN_DENY,
  },
  {
    ats: "factorial",
    cdxQuery: "*.factorialhr.com/*",
    regex: /https?:\/\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\.factorialhr\.com/gi,
    denyList: SUBDOMAIN_DENY,
  },
  {
    ats: "eightfold",
    cdxQuery: "*.eightfold.ai/*",
    regex: /https?:\/\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\.eightfold\.ai/gi,
    denyList: SUBDOMAIN_DENY,
  },
  // Phase-6 custom ATSes — each is single-tenant, so group 1 captures
  // the literal canonical slug embedded in the host. CDX surfaces the
  // public board URL on every page of recent crawls, so harvest will
  // discover the single tenant on the first matching record and stop
  // (extractSlugs dedupes by slug).
  {
    ats: "amazonjobs",
    cdxQuery: "amazon.jobs/*",
    regex: /https?:\/\/(amazon)\.jobs\b/gi,
    denyList: new Set<string>(),
  },
  {
    ats: "applejobs",
    cdxQuery: "jobs.apple.com/*",
    regex: /https?:\/\/jobs\.(apple)\.com\b/gi,
    denyList: new Set<string>(),
  },
  {
    ats: "tiktokcareers",
    cdxQuery: "careers.tiktok.com/*",
    regex: /https?:\/\/careers\.(tiktok)\.com\b/gi,
    denyList: new Set<string>(),
  },
  {
    ats: "metacareers",
    cdxQuery: "metacareers.com/*",
    regex: /https?:\/\/(?:www\.)?(meta)careers\.com\b/gi,
    denyList: new Set<string>(),
  },
  // Phase-7 single-tenant scrapers. Each is a custom careers stack;
  // the regex captures the literal canonical slug embedded in the host.
  {
    ats: "infosys",
    cdxQuery: "career.infosys.com/*",
    regex: /https?:\/\/career\.(infosys)\.com\b/gi,
    denyList: new Set<string>(),
  },
  {
    ats: "tcs",
    cdxQuery: "tcs.com/careers/*",
    regex: /https?:\/\/(?:www\.)?(tcs)\.com\/careers\b/gi,
    denyList: new Set<string>(),
  },
  {
    ats: "wipro",
    cdxQuery: "careers.wipro.com/*",
    regex: /https?:\/\/careers\.(wipro)\.com\b/gi,
    denyList: new Set<string>(),
  },
  {
    ats: "ltimindtree",
    cdxQuery: "ltimindtree.com/careers/*",
    regex: /https?:\/\/(?:www\.)?(ltimindtree)\.com\/careers\b/gi,
    denyList: new Set<string>(),
  },
  // Phenom is multi-tenant with no single canonical host (each customer
  // has its own careers domain), so CDX-driven harvest can't enumerate
  // tenants. We register a placeholder pattern that never matches,
  // satisfying the "HARVEST_ATS_IDS == ATS_IDS" invariant while making
  // the no-auto-harvest property explicit in code rather than implicit.
  {
    ats: "phenom",
    cdxQuery: "phenompeople.com/*",
    // Matches the vendor's own marketing site, never a customer host;
    // groups 1 captures the vendor name, which is denied at the slug
    // level — so this pattern is effectively a no-op for harvest while
    // documenting that Phenom is the platform we intentionally don't
    // try to auto-discover.
    regex: /https?:\/\/(?:www\.)?(phenompeople)\.com\b/gi,
    denyList: new Set<string>(["phenompeople"]),
  },
  // Phase-7B retail one-offs (single-tenant)
  {
    ats: "traderjoes",
    cdxQuery: "traderjoes.com/careers/*",
    regex: /https?:\/\/(?:www\.)?(traderjoes)\.com\b/gi,
    denyList: new Set<string>(),
  },
  {
    ats: "publix",
    cdxQuery: "publix.com/careers/*",
    regex: /https?:\/\/corporate\.(publix)\.com\b/gi,
    denyList: new Set<string>(),
  },
  {
    ats: "seveneleven",
    // The brand uses both `7-eleven` and `7eleven` in URLs across
    // their properties. Match either; emit canonical `seveneleven`.
    cdxQuery: "careers.7-eleven.com/*",
    regex: /https?:\/\/careers\.(?:7-eleven|7eleven)\.com\b/gi,
    denyList: new Set<string>(),
    // Synthesise the canonical slug since the URL has digits/hyphens.
    extractMetadata: () => ({ tenant: "seveneleven" }),
  },
  {
    ats: "aldi",
    cdxQuery: "careers.aldi.us/*",
    regex: /https?:\/\/careers\.(aldi)\.us\b/gi,
    denyList: new Set<string>(),
  },
  {
    ats: "successfactors",
    // SuccessFactors career sites are addressed by a regional datacenter
    // host (`career{N}.successfactors.{eu|com|de|com.cn|fr|co.uk}`) plus
    // a `company={slug}` query parameter. The slug is the only
    // tenant-identifier; the datacenter host is per-tenant routing
    // metadata that we capture so the scraper knows which regional
    // cluster to hit.
    //
    // extractSlugs reads `m[1]` as the slug (convention shared with
    // every other pattern), so group 1 captures the slug from the
    // query string. The host is parsed out of the full match string
    // inside extractMetadata via a secondary regex; SuccessFactors is
    // the only ATS where the slug is not part of the host, so the
    // pattern is necessarily a little unusual.
    cdxQuery: "*.successfactors.*",
    regex:
      /https?:\/\/career[0-9]{1,3}\.successfactors\.(?:com|eu|de|com\.cn|fr|co\.uk)\/career\?[^"\s]*company=([a-z0-9-]+)/gi,
    denyList: SUBDOMAIN_DENY,
    extractMetadata: (match) => {
      const hostMatch = /career[0-9]{1,3}\.successfactors\.(?:com|eu|de|com\.cn|fr|co\.uk)/i.exec(
        match[0],
      );
      return hostMatch ? { host: hostMatch[0] } : undefined;
    },
  },
];

const PATTERNS_BY_ATS: ReadonlyMap<ATSId, AtsHarvestPattern> = new Map(
  HARVEST_PATTERNS.map((p) => [p.ats, p]),
);

export function harvestPatternFor(ats: ATSId): AtsHarvestPattern {
  const p = PATTERNS_BY_ATS.get(ats);
  if (!p) throw new Error(`no harvest pattern for ats ${ats}`);
  return p;
}

export const HARVEST_ATS_IDS: ReadonlyArray<ATSId> = HARVEST_PATTERNS.map((p) => p.ats);

export const SLUG_PATTERN: RegExp = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
