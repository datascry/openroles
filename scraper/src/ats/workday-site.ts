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

const SITE_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

// Workday emits a small set of admin-style first-segments under Allow
// on some tenants (e.g. `/refreshFacet/` for facet refresh hits). These
// aren't site labels — skip them and keep scanning.
const ADMIN_SEGMENTS = new Set<string>(["refreshFacet"]);

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
  let allowSite: string | null = null;
  let sitemapSite: string | null = null;
  for (const rawLine of robotsTxt.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (line === "") continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const directive = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (directive === "allow") {
      if (allowSite === null) allowSite = siteFromAllow(value);
    } else if (directive === "sitemap") {
      if (sitemapSite === null) sitemapSite = siteFromSitemap(value);
    }
  }
  return allowSite ?? sitemapSite;
}
