// 4.0.0 lands the IBM Kenexa / BrassRing adapter (`brassring` ATSId).
// Major bump for the same reason as 3.0.0 (adding an ATSId is symmetric
// to removing one — `ATSCountsSchema` is `.strict()` so a 3.0.0 reader
// rejects a 4.0.0 manifest with `ats_counts.brassring = 0`).
//
// Multi-tenant ATS shared at sjobs.brassring.com. Tenant identity =
// (partnerid, siteid) — both numeric IDs, captured as string-form
// `metadata.partnerid` + `metadata.siteid`. Verified live with Publix
// (26173/5197) end-to-end; Common Crawl yields 123 distinct
// (partnerid, siteid) pairs in the latest snapshot. Initial seed set
// covers Publix, Hobby Lobby, Harbor Freight Tools, Best Buy, HCL
// Technologies, ADM, Performance Food Group, GardaWorld, Habitat for
// Humanity, Helzberg, Yale University — 11 enterprise / university
// tenants whose Workday/Taleo/SuccessFactors corpus entries were
// silently failing or never existed. Widens ATSId 30 → 31.
//
// 3.0.0 lands the vendor-agnostic JSON-LD harvester (`jsonld` ATSId).
// Major bump because adding an ATSId to the closed union is symmetric
// to removing one: `ATSCountsSchema` in shared/src/schema/manifest.ts
// is `.strict()`, so a 2.0.0 reader processing a 3.0.0 manifest emitted
// with `ats_counts.jsonld = 0` would reject by unknown-key. PR-A bumped
// 1.7.0 → 2.0.0 for removing `phenom`; this addition is the symmetric
// break for older readers and gets the same major-bump treatment.
//
// The adapter walks a per-tenant sitemap URL and extracts
// `schema.org/JobPosting` JSON-LD blocks from each linked page. Tenant
// identity = (slug, sitemap_url). Unlocks the long tail of brands whose
// careers stack is proprietary but who serve Google-for-Jobs structured
// data for SEO. First verified seeds: Lockheed Martin, AT&T, Comcast,
// Spectrum — all currently on TalentBrew but the adapter is vendor-
// neutral so any future tenant emitting JobPosting JSON-LD plugs in by
// hand-seeding `metadata.sitemap_url`. Widens ATSId 29 → 30. (Marriott
// is also TalentBrew-hosted but uses a sitemap-index pointing to per-
// locale sub-sitemaps; sitemap-index recursion lands in a follow-up.)
//
// 2.0.0 reverts the Phenom adapter introduced in 1.7.0. Major bump because
// removing an ATSId from the closed union is a backward-incompatible read
// break: `ATSCountsSchema` in shared/src/schema/manifest.ts is `.strict()`,
// so a 1.7.0 manifest emitted with `ats_counts.phenom = 0` would be
// rejected by a 2.0.0 reader. The wire data itself never carried a
// "phenom" `jobs.ats` value (zero tenants were ever seeded), but the
// manifest-level `ats_counts` keys did, so the read path is the
// constrained surface. No 1.7.0 manifest was ever deployed (the production
// build was 1.5.0 at the time of revert), so the break is theoretical for
// the deploy pipeline today; the major bump records it for any reader
// that pulls a 1.7.0 artifact built locally or in a stale CI cache.
//
// Post-validation found that the Phenom-fingerprinted brands probed during
// PR planning (CVS Health, Mastercard, Toyota) are SEO veneer front-ends
// whose `applyUrl` field on every job posts back to the brand's existing
// Workday tenant — all three already covered as live workday tenants.
// Seeding Phenom for these brands would create per-job duplicates under
// a different `url` (the `jobs UNIQUE(url)` constraint doesn't dedupe
// across ATSes). The 1.7.0 fixtures were also hand-crafted with synthetic
// data and the adapter's `/api/jobs` endpoint path returned 500/404 on
// every Phenom-fingerprinted host probed; the real path is `/api/jobs/search`
// gated behind tenant-context cookies. Narrows ATSId 30 → 29.
// See docs/audits/2026-05-14-brand-coverage-validation.md.
//
// 1.7.0 lands Phase-7: Phenom People — a multi-tenant ATS used by
// Walgreens, CVS, BP, ExxonMobil, GAP, TI, AMD, and roughly 600 more
// Fortune-1000 employers. Tenant identity = (slug, host) pair where
// host is the per-customer careers domain. Widens ATSId 29 → 30.
// Single highest-leverage adapter addition since the Workday adapter:
// one multi-tenant adapter unlocks hundreds of tier-1 brands at once.
// (Reverted in 2.0.0 — see entry above.)
//
// (Indian-IT adapters originally planned for this phase — Infosys,
// TCS, Wipro, LTIMindtree — were dropped after the 2026-05-14
// speculative-scraper audit found their endpoint paths and response
// shapes were unverified. See
// docs/audits/2026-05-14-speculative-scraper-audit.md.)
//
// 1.6.0 lands Phase-6 per-company custom ATSes for FAANG-tier brands
// whose public boards run on bespoke infrastructure: amazonjobs (the
// amazon.jobs public JSON API), applejobs (jobs.apple.com role-search
// JSON), tiktokcareers (careers.tiktok.com jobsearch JSON), and
// metacareers (metacareers.com REST). Each is a single-tenant "ATS"
// keyed by the company name; widens ATSId 25 → 29. Phase plan row 6
// (deferred since project start) moves to delivered.
//
// 1.5.0 widens ATSId from 24 to 25 by adding `successfactors`. SAP's
// SuccessFactors hosts a significant slice of Fortune-500 hiring
// (SAP itself, Adidas, BMW, Costco, Publix, much of the EU-based
// manufacturing sector). Reads of pre-1.5.0 manifests stay clean
// because manifest.ats_counts auto-defaults missing ATS keys to 0.
//
// 1.4.0 formalises workday tenant metadata.site as a robots.txt-discovered
// label. Tenant metadata already accepted arbitrary string keys, so reads
// of older tenant files remain backward-compatible — entries that pre-date
// 1.4.0 simply lack the site key and the scraper continues to fall back
// to the hardcoded External / Careers probe chain. See
// scraper/src/ats/workday-site.ts for the parser and
// scraper/src/ats/workday-site-fetch.ts for the discovery wrapper.
//
// 1.3.0 introduces the role lifecycle (specs/role-lifecycle.md): the build
// pipeline carries forward roles whose tenant didn't scrape today, marks
// them is_stale=1, and drops them after STALE_TTL_DAYS_DEFAULT misses.
// Manifest gains fresh_count / stale_count / stale_ttl_days. Manifests
// built against 1.2.0 remain readable since the new manifest fields have
// defaults and is_stale defaults to false.
//
// 1.2.0 extends ATSId to 24 ids: phase-9 added the first widening to 12
// (recruitee, breezy, personio, workable, teamtailor, smartrecruiters);
// this revision adds twelve more (csod, taleo, ultipro, jobvite,
// zohorecruit, talentlyft, pinpointhq, applicantpro, applicantstack,
// homerun, factorial, eightfold). All additions ship harvest + probe;
// scraper modules land progressively. Manifests built against earlier
// schema versions remain readable since ats_counts keys default to 0.
export const SCHEMA_VERSION = "4.0.0";

/**
 * Default number of days a role can stay marked is_stale before it drops
 * from the database. Configurable via build-db --stale-ttl-days <n>.
 * See specs/role-lifecycle.md.
 */
export const STALE_TTL_DAYS_DEFAULT = 3;

export * from "./classifiers/index.ts";
export * from "./schema/index.ts";
