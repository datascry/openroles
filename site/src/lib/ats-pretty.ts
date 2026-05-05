/**
 * Display labels for ATS ids. Two shapes per id:
 *   - `long`  for prose surfaces (apply CTA, fact card, "Source: …")
 *   - `short` for bylines and dense lists where every character costs space
 *
 * Single source of truth. Components MUST NOT inline these strings; reach
 * for the helpers below.
 */
export interface AtsLabel {
  readonly long: string;
  readonly short: string;
}

const ATS_LABELS: Record<string, AtsLabel> = {
  greenhouse: { long: "Greenhouse", short: "GH" },
  lever: { long: "Lever", short: "LEVER" },
  ashby: { long: "Ashby", short: "ASHBY" },
  bamboohr: { long: "BambooHR", short: "BAMBOO" },
  workday: { long: "Workday", short: "WORKDAY" },
  icims: { long: "iCIMS", short: "ICIMS" },
  recruitee: { long: "Recruitee", short: "RECRUITEE" },
  breezy: { long: "Breezy", short: "BREEZY" },
  personio: { long: "Personio", short: "PERSONIO" },
  workable: { long: "Workable", short: "WORKABLE" },
  teamtailor: { long: "Teamtailor", short: "TEAMTAILOR" },
  smartrecruiters: { long: "SmartRecruiters", short: "SMARTREC" },
  csod: { long: "Cornerstone", short: "CORNERSTONE" },
  taleo: { long: "Taleo", short: "TALEO" },
  ultipro: { long: "UltiPro", short: "ULTIPRO" },
  jobvite: { long: "Jobvite", short: "JOBVITE" },
  zohorecruit: { long: "Zoho Recruit", short: "ZOHO" },
  talentlyft: { long: "TalentLyft", short: "TALENTLYFT" },
  pinpointhq: { long: "Pinpoint HQ", short: "PINPOINT" },
  applicantpro: { long: "ApplicantPro", short: "APPLICANTPRO" },
  applicantstack: { long: "ApplicantStack", short: "APPLICANTSTACK" },
  homerun: { long: "Homerun", short: "HOMERUN" },
  factorial: { long: "Factorial", short: "FACTORIAL" },
  eightfold: { long: "Eightfold", short: "EIGHTFOLD" },
};

/** Long-form pretty label (prose). Falls back to upper-cased id. */
export function atsLong(id: string): string {
  return ATS_LABELS[id]?.long ?? id;
}

/** Short-form pretty label (byline / dense lists). Falls back to upper-cased id. */
export function atsShort(id: string): string {
  return ATS_LABELS[id]?.short ?? id.toUpperCase();
}
