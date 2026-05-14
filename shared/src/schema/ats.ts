import { z } from "zod";

// Canonical sort order for the ATS dimension. Phase-1 set (greenhouse →
// icims) is followed by phase-9 additions; new entries append to preserve
// stable hash ordering in any persisted records that use ATS_RANK.
export const ATS_IDS = Object.freeze([
  "greenhouse",
  "lever",
  "ashby",
  "bamboohr",
  "workday",
  "icims",
  "recruitee",
  "breezy",
  "personio",
  "workable",
  "teamtailor",
  "smartrecruiters",
  "csod",
  "taleo",
  "ultipro",
  "jobvite",
  "zohorecruit",
  "talentlyft",
  "pinpointhq",
  "applicantpro",
  "applicantstack",
  "homerun",
  "factorial",
  "eightfold",
  "successfactors",
  // Phase 6: per-company custom ATSes. Each is a single-tenant "ATS"
  // whose only "slug" is the company name. They are added as distinct
  // ATSIds (not a synthetic `custom` umbrella) so manifest.ats_counts,
  // observability, and the run-report carry the same per-vendor shape
  // as every other ATS.
  "amazonjobs",
  "applejobs",
  "tiktokcareers",
  "metacareers",
] as const);

export type ATSId = (typeof ATS_IDS)[number];

export const ATSIdSchema = z.enum([...ATS_IDS]);
