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
