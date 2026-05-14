// Workday tenants expose their public job board under
// `/wday/cxs/{slug}/{site}/jobs`, where {site} is a per-tenant label like
// `External`, `Careers`, `GOCJobs`, or `external_experienced`. The label
// is not derivable from the slug; without it the cxs JSON 404s for the
// long tail of tenants that don't use one of the common defaults.
//
// The Workday root URL is gated by an anti-bot CDN (HTTP 406 to
// scrapers), but `/robots.txt` is publicly served and contains the site
// label in two places:
//   Allow:   /<SITE>/
//   Sitemap: https://{host}/<SITE>/siteMap.xml
//
// Allow is the canonical directive; Sitemap is a secondary signal that
// can lag behind a renamed board, so we prefer Allow when both are
// present.

// Workday tenants commonly name their site with a leading letter
// (External, Careers, ATTGeneral) but the platform permits leading
// digits too (23andme's `/23/`, several other "year-prefixed" sites).
// Restricting to leading-letter dropped 23andme onto the empty
// `redditsite` rather than the 11-job `/23/`. The character class
// is otherwise unchanged.
const SITE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

// Workday emits a small set of admin-style first-segments under Allow
// on some tenants (e.g. `/refreshFacet/` for facet refresh hits). These
// aren't site labels — skip them and keep scanning.
const ADMIN_SEGMENTS = new Set<string>(["refreshFacet"]);

// Tenants commonly expose several sites under one Workday host
// (AT&T: ATTGeneral / ATTCollege / Cricket — 1,133 / 12 / 0 jobs;
// Kyndryl: KyndrylProfessionalCareers / KyndrylEarlyCareers —
// 864 / 17). Score each candidate so the broad-audience site wins
// over a narrow or specialty one. Tie-break by robots.txt order
// (stable sort).
//
// Scoring works on whole-word tokens, not substrings. The segment is
// split on underscores, hyphens, and camelCase boundaries; each
// resulting token is matched case-insensitively against the keyword
// sets below. Substring matching produced false positives ("intern"
// inside "International", "career" inside "EarlyCareers") and
// substring negatives (a narrow Early-Careers site scoring +5 for
// "career" while the broad Professional-Careers site scored only +5
// — same score, picked first-Allow, wrong answer).
//
// The keyword lists include singular + plural where Workday tenants
// have been observed using both forms.
const BROAD_KEYWORDS = new Set([
  "external",
  "externals",
  "general",
  "generals",
  "career",
  "careers",
  "main",
  "public",
  "global",
  "globals",
  "professional",
  "professionals",
  "experienced",
]);
const NARROW_KEYWORDS = new Set([
  "college",
  "colleges",
  "intern",
  "interns",
  "internship",
  "internships",
  "internal",
  "internals",
  "special",
  "specials",
  "invite",
  "invites",
  "admin",
  "admins",
  "alum",
  "alumni",
  "early",
  "student",
  "students",
  "apprentice",
  "apprentices",
  "apprenticeship",
  "apprenticeships",
  "graduate",
  "graduates",
  "temporary",
  "temp",
  "temps",
]);

/**
 * Split `KyndrylEarlyCareers` / `Unilever_Early_Careers` /
 * `external-experienced` / `ATTCollege` into the word-tokens we score
 * against. Lowercases each token; drops empty fragments.
 *
 * Handles three camelCase boundary cases:
 *   - `aB` (lower or digit to upper): `KyndrylProfessional` → Kyndryl|Professional
 *   - `ABc` (upper run to upper+lower): `ATTCollege` → ATT|College
 *   - explicit separators: `_`, `-`
 */
function tokenize(segment: string): string[] {
  const withSeparators = segment
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2");
  return withSeparators
    .split(/[_-]+/)
    .map((s) => s.toLowerCase())
    .filter((s) => s.length > 0);
}

function siteScore(segment: string): number {
  let score = 0;
  for (const token of tokenize(segment)) {
    if (BROAD_KEYWORDS.has(token)) score += 5;
    if (NARROW_KEYWORDS.has(token)) score -= 10;
  }
  return score;
}

function pickSite(segment: string | undefined): string | null {
  if (segment === undefined) return null;
  if (segment.length === 0) return null;
  if (ADMIN_SEGMENTS.has(segment)) return null;
  if (!SITE_RE.test(segment)) return null;
  return segment;
}

function firstPathSegment(rawPath: string): string | undefined {
  const trimmed = rawPath.replace(/^\/+/, "");
  if (trimmed.length === 0) return undefined;
  const slashIdx = trimmed.indexOf("/");
  return slashIdx === -1 ? trimmed : trimmed.slice(0, slashIdx);
}

function siteFromAllow(value: string): string | null {
  return pickSite(firstPathSegment(value.trim()));
}

function siteFromSitemap(value: string): string | null {
  const trimmed = value.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  return pickSite(firstPathSegment(url.pathname));
}

export function parseWorkdaySite(robotsTxt: string): string | null {
  const allowSites: string[] = [];
  let sitemapSite: string | null = null;
  for (const rawLine of robotsTxt.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (line === "") continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const directive = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (directive === "allow") {
      const site = siteFromAllow(value);
      if (site !== null) allowSites.push(site);
    } else if (directive === "sitemap") {
      if (sitemapSite === null) sitemapSite = siteFromSitemap(value);
    }
  }
  if (allowSites.length > 0) {
    // Stable score-descending sort. When two Allow directives have the
    // same score (the typical case, score=0), the earlier-listed one
    // wins — matches the previous "first Allow" behaviour for tenants
    // that don't trigger any keyword bonus or penalty.
    return (
      [...allowSites]
        .map((s, i) => ({ s, i, score: siteScore(s) }))
        .sort((a, b) => b.score - a.score || a.i - b.i)[0]?.s ?? null
    );
  }
  return sitemapSite;
}
