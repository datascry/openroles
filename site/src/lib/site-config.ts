/**
 * Canonical site identity — single source of truth for the public URL.
 *
 * Imported by:
 *   - `site/astro.config.ts` (drives `Astro.site`, sitemap base, canonical URLs)
 *   - `site/scripts/*-live.ts` (probe / perf / qa default targets)
 *   - `site/src/layouts/BaseLayout.astro` (siteOrigin defensive fallback)
 *
 * Surfaces that can't read TypeScript at build time keep the hostname
 * inline AND cross-reference this file with a comment, so a domain
 * migration is a single search-and-update operation. Current list:
 *   - `site/public/CNAME`
 *   - `site/public/robots.txt` (Sitemap URL)
 *   - `.github/workflows/build-deploy.yml` (PAGES_BASE env)
 *   - `.github/workflows/release.yml` (PAGES_BASE env)
 *
 * The README is a content surface (badges, try-it URLs, dev hints) and
 * is not considered a duplicate of this constant — it's authored prose
 * that happens to reference the URL, like any external doc would.
 *
 * If the domain moves again, update this file plus the four surfaces
 * listed above. The grep `git grep openroles.today` is the audit.
 */
export const SITE_ORIGIN = "https://openroles.today" as const;

/**
 * Bare hostname (no scheme, no trailing slash). Useful for tag-templates
 * that build a URL piecewise, or for the CNAME-style host-only context.
 */
export const SITE_HOST = "openroles.today" as const;
