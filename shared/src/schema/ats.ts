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
  // Vendor-agnostic JSON-LD harvester. Walks a per-tenant sitemap URL
  // and extracts `schema.org/JobPosting` JSON-LD blocks from each linked
  // page. Tenant identity = (slug, sitemap_url). The underlying careers
  // stack is opaque to the adapter; this unlocks brands whose stack is
  // proprietary but who serve Google-for-Jobs structured data anyway
  // (the TalentBrew-backed family — Lockheed Martin, AT&T, Comcast,
  // Marriott, Spectrum — being the first verified seed set).
  "jsonld",
] as const);

export type ATSId = (typeof ATS_IDS)[number];

export const ATSIdSchema = z.enum([...ATS_IDS]);
