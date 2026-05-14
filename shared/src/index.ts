// 1.7.0 lands Phase-7 expansion: Phenom People (multi-tenant ATS used
// by Walgreens, CVS, BP, ExxonMobil, GAP, TI, AMD, and ~600 more
// Fortune-1000 employers) plus the Indian-IT-giant trio Infosys, TCS,
// Wipro, and LTIMindtree (each a single-tenant proprietary careers
// stack with a public-but-undocumented search api). Widens ATSId
// 29 → 34. Phenom is the single highest-leverage addition since the
// Workday adapter — adding a multi-tenant adapter unlocks hundreds
// of tier-1 brands at once.
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
export const SCHEMA_VERSION = "1.7.0";

/**
 * Default number of days a role can stay marked is_stale before it drops
 * from the database. Configurable via build-db --stale-ttl-days <n>.
 * See specs/role-lifecycle.md.
 */
export const STALE_TTL_DAYS_DEFAULT = 3;

export * from "./classifiers/index.ts";
export * from "./schema/index.ts";
