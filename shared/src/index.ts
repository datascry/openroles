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
export const SCHEMA_VERSION = "1.4.0";

/**
 * Default number of days a role can stay marked is_stale before it drops
 * from the database. Configurable via build-db --stale-ttl-days <n>.
 * See specs/role-lifecycle.md.
 */
export const STALE_TTL_DAYS_DEFAULT = 3;

export * from "./classifiers/index.ts";
export * from "./schema/index.ts";
