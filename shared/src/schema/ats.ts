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
] as const);

export type ATSId = (typeof ATS_IDS)[number];

export const ATSIdSchema = z.enum([...ATS_IDS]);
