import type { ATSId } from "@openroles/shared";

export interface AtsHarvestPattern {
  readonly ats: ATSId;
  readonly cdxQuery: string;
  readonly regex: RegExp;
  readonly denyList: ReadonlySet<string>;
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
    cdxQuery: "*.myworkdayjobs.com/*",
    regex:
      /https?:\/\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\.wd\d+(?:-[a-z0-9-]+)?\.myworkdayjobs\.com/gi,
    denyList: SUBDOMAIN_DENY,
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
    // Path-based: recruiting.ultipro.com/{TENANT_CODE}/JobBoard/{guid}/...
    // The slug is the first path segment, an uppercase alphanumeric code
    // (5-32 chars). Lowercased on extraction so it round-trips through the
    // shared SLUG_PATTERN, then uppercased again at probe/scrape URL time.
    cdxQuery: "recruiting.ultipro.com/*",
    regex: /recruiting\.ultipro\.com\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)(?:[/?#]|$)/gi,
    denyList: PATH_DENY,
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
