// 1.2.0 extends ATSId to 24 ids: phase-9 added the first widening to 12
// (recruitee, breezy, personio, workable, teamtailor, smartrecruiters);
// this revision adds twelve more (csod, taleo, ultipro, jobvite,
// zohorecruit, talentlyft, pinpointhq, applicantpro, applicantstack,
// homerun, factorial, eightfold). All additions ship harvest + probe;
// scraper modules land progressively. Manifests built against earlier
// schema versions remain readable since ats_counts keys default to 0.
export const SCHEMA_VERSION = "1.2.0";

export * from "./classifiers/index.ts";
export * from "./schema/index.ts";
