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
]);

const HARVEST_PATTERNS: ReadonlyArray<AtsHarvestPattern> = [
  {
    ats: "greenhouse",
    cdxQuery: "boards.greenhouse.io/*",
    // Two alternations: the canonical /{slug} board URL and the iframe embed
    // URL boards.greenhouse.io/embed/job_app?for={slug}. Whichever alternation
    // fires populates the corresponding capture group.
    regex:
      /boards\.greenhouse\.io\/(?:embed\/job_app\?for=([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)|([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)(?:[/?#]|$))/gi,
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
    cdxQuery: "careers-*.icims.com/*",
    regex: /careers-([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)\.icims\.com/gi,
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
