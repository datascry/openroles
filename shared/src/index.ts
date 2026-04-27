// 1.1.0 widens ATSId from 6 to 12 ids (adds recruitee, breezy, personio,
// workable, teamtailor, smartrecruiters). Manifests built against 1.0.0
// remain readable: the new ats_counts keys default to 0 when absent.
export const SCHEMA_VERSION = "1.1.0";

export * from "./classifiers/index.ts";
export * from "./schema/index.ts";
