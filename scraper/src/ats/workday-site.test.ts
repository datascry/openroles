import { describe, expect, it } from "bun:test";
import fc from "fast-check";
import { parseWorkdaySite } from "./workday-site.ts";

describe("parseWorkdaySite", () => {
  it("extracts the standard External label from an Allow directive", () => {
    const robots = "User-agent: *\nAllow: /External/\nDisallow: /refreshFacet/\n";
    expect(parseWorkdaySite(robots)).toBe("External");
  });

  it("extracts a snake_case label like external_experienced", () => {
    const robots = "User-agent: *\nAllow: /external_experienced/\n";
    expect(parseWorkdaySite(robots)).toBe("external_experienced");
  });

  it("preserves mixed-case labels like NVIDIAExternalCareerSite", () => {
    const robots = "User-agent: *\nAllow: /NVIDIAExternalCareerSite/\n";
    expect(parseWorkdaySite(robots)).toBe("NVIDIAExternalCareerSite");
  });

  it("accepts site labels that begin with a digit (e.g. 23andme's /23/)", () => {
    // Workday permits site names with leading digits. 23andme's robots.txt
    // lists three Allow directives (`/23/`, `/redditsite/`, `/23A/`); the
    // first lexically is `/23/` which has 11 live jobs. A previous
    // start-with-letter regex rejected it and the parser silently picked
    // `redditsite` (0 jobs).
    const robots = ["User-agent: *", "Allow: /23/", "Allow: /redditsite/", "Allow: /23A/", ""].join(
      "\n",
    );
    expect(parseWorkdaySite(robots)).toBe("23");
  });

  it("prefers broad-audience sites (General) over narrow ones (College)", () => {
    // AT&T's robots.txt lists ATTCollege first alphabetically, but the
    // broad-audience site is ATTGeneral (1,133 vs 12 jobs). The keyword
    // scoring resolves this: ATTGeneral gets +5 for "general",
    // ATTCollege gets -10 for "college", Cricket scores 0.
    const robots = [
      "User-agent: *",
      "Allow: /ATTCollege/",
      "Allow: /ATTGeneral/",
      "Allow: /Cricket/",
      "",
    ].join("\n");
    expect(parseWorkdaySite(robots)).toBe("ATTGeneral");
  });

  it("preserves first-Allow order when sites tie on score (no keyword hits)", () => {
    // 23andme's three sites (`23`, `redditsite`, `23A`) all score 0 —
    // no broad or narrow keyword hits. Stable sort returns the
    // earliest-listed: `23`.
    const robots = ["User-agent: *", "Allow: /23/", "Allow: /redditsite/", "Allow: /23A/", ""].join(
      "\n",
    );
    expect(parseWorkdaySite(robots)).toBe("23");
  });

  it("ignores `Search` as not a narrow keyword (3m's only site)", () => {
    // 3m's robots.txt has just one Allow (`/Search/`) and that site
    // yields 610 real jobs. We must not penalise it.
    const robots = "User-agent: *\nAllow: /Search/\n";
    expect(parseWorkdaySite(robots)).toBe("Search");
  });

  it("prefers Professional over Early (Kyndryl: 864 vs 17 jobs)", () => {
    // KyndrylProfessionalCareers tokens: kyndryl / professional / careers
    //   → +5 (professional) + 5 (careers) = +10
    // KyndrylEarlyCareers tokens: kyndryl / early / careers
    //   → -10 (early) + 5 (careers) = -5
    const robots = [
      "User-agent: *",
      "Allow: /KyndrylEarlyCareers/",
      "Allow: /KyndrylProfessionalCareers/",
      "",
    ].join("\n");
    expect(parseWorkdaySite(robots)).toBe("KyndrylProfessionalCareers");
  });

  it("handles underscore-separated narrow keywords (Unilever_Early_Careers)", () => {
    // Unilever_Early_Careers tokens: unilever / early / careers
    //   → -10 + 5 = -5
    // Unilever_Experienced_Professionals tokens: unilever / experienced / professionals
    //   → +5 + 5 = +10
    const robots = [
      "User-agent: *",
      "Allow: /Unilever_Early_Careers/",
      "Allow: /Unilever_Experienced_Professionals/",
      "",
    ].join("\n");
    expect(parseWorkdaySite(robots)).toBe("Unilever_Experienced_Professionals");
  });

  it("does NOT penalize International (whole-token, not substring 'intern')", () => {
    // The pre-token-match heuristic substring-matched "intern" inside
    // "International" — wrong. International is a real Workday site
    // name; the parser must score it as neutral, not narrow.
    const robots = ["User-agent: *", "Allow: /HUBInternational/", "Allow: /Internship/", ""].join(
      "\n",
    );
    // HUBInternational: tokens hub / international → 0 (neither set)
    // Internship: tokens internship → -10
    // Score-descending picks HUBInternational.
    expect(parseWorkdaySite(robots)).toBe("HUBInternational");
  });

  it("penalises Apprenticeships vs Graduates_and_Professionals (TRUMPF case)", () => {
    // TRUMPF_Apprenticeships tokens: trumpf / apprenticeships → -10
    // TRUMPF_Graduates_and_Professionals tokens: trumpf / graduates / and / professionals
    //   → -10 (graduates) + 5 (professionals) = -5
    // Both negative — but the second is higher (less narrow).
    const robots = [
      "User-agent: *",
      "Allow: /TRUMPF_Apprenticeships/",
      "Allow: /TRUMPF_Graduates_and_Professionals/",
      "",
    ].join("\n");
    expect(parseWorkdaySite(robots)).toBe("TRUMPF_Graduates_and_Professionals");
  });

  it("falls back to the Sitemap URL when no Allow line is present", () => {
    const robots =
      "User-agent: *\nSitemap: https://example.wd5.myworkdayjobs.com/GOCJobs/siteMap.xml\n";
    expect(parseWorkdaySite(robots)).toBe("GOCJobs");
  });

  it("uses Allow when only an Allow line is present (no Sitemap)", () => {
    const robots = "User-agent: *\nAllow: /Careers/\n";
    expect(parseWorkdaySite(robots)).toBe("Careers");
  });

  it("agrees when Allow and Sitemap reference the same site", () => {
    const robots = [
      "User-agent: *",
      "Allow: /External/",
      "Sitemap: https://co.wd5.myworkdayjobs.com/External/siteMap.xml",
      "",
    ].join("\n");
    expect(parseWorkdaySite(robots)).toBe("External");
  });

  it("prefers Allow over Sitemap when they disagree", () => {
    // Empirically rare, but Allow is the canonical site-label directive
    // and Sitemap can lag behind a renamed board. Prefer Allow.
    const robots = [
      "User-agent: *",
      "Allow: /Careers/",
      "Sitemap: https://co.wd5.myworkdayjobs.com/External/siteMap.xml",
      "",
    ].join("\n");
    expect(parseWorkdaySite(robots)).toBe("Careers");
  });

  it("returns null for an empty robots.txt", () => {
    expect(parseWorkdaySite("")).toBeNull();
  });

  it("returns null for a robots.txt with only Disallow lines", () => {
    const robots = "User-agent: *\nDisallow: /\n";
    expect(parseWorkdaySite(robots)).toBeNull();
  });

  it("returns the first non-admin Allow path when multiple are present", () => {
    // Workday emits `/refreshFacet/` and similar admin endpoints under
    // Allow on some tenants — those aren't site labels. Skip them and
    // return the first plausible site segment.
    const robots = [
      "User-agent: *",
      "Allow: /refreshFacet/",
      "Allow: /External/",
      "Allow: /Careers/",
      "",
    ].join("\n");
    expect(parseWorkdaySite(robots)).toBe("External");
  });

  it("rejects an empty path Allow directive", () => {
    const robots = "User-agent: *\nAllow: /\n";
    expect(parseWorkdaySite(robots)).toBeNull();
  });

  it("rejects admin-style paths even on a Sitemap line", () => {
    const robots =
      "User-agent: *\nSitemap: https://x.wd5.myworkdayjobs.com/refreshFacet/sitemap.xml\n";
    expect(parseWorkdaySite(robots)).toBeNull();
  });

  it("ignores lines with non-site-shaped paths (slashes inside the segment)", () => {
    const robots = "User-agent: *\nAllow: /something/with/extra/\n";
    // The first segment `something` is fine on its own — we extract the
    // first segment, not the whole path.
    expect(parseWorkdaySite(robots)).toBe("something");
  });

  it("strips trailing slash and ignores leading whitespace", () => {
    const robots = "User-agent: *\n  Allow:   /External/   \n";
    expect(parseWorkdaySite(robots)).toBe("External");
  });

  it("is case-insensitive on the directive name", () => {
    const robots = "User-agent: *\nALLOW: /External/\n";
    expect(parseWorkdaySite(robots)).toBe("External");
  });

  it("never throws on arbitrary string input (property)", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        // Pure parser; should never throw regardless of input shape.
        const result = parseWorkdaySite(s);
        return result === null || typeof result === "string";
      }),
      { numRuns: 200 },
    );
  });

  it("returns a label that round-trips through the workday-site charset", () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[A-Za-z][A-Za-z0-9_-]{0,40}$/), (label) => {
        const robots = `User-agent: *\nAllow: /${label}/\n`;
        const parsed = parseWorkdaySite(robots);
        return parsed === label;
      }),
      { numRuns: 50 },
    );
  });
});
