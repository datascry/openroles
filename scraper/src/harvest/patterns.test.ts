import { describe, expect, it } from "bun:test";
import { ATS_IDS } from "@openroles/shared";
import { HARVEST_ATS_IDS, harvestPatternFor } from "./patterns.ts";

describe("harvestPatternFor", () => {
  it("returns a pattern for every canonical ATS", () => {
    for (const ats of ATS_IDS) {
      const p = harvestPatternFor(ats);
      expect(p.ats).toBe(ats);
      expect(p.cdxQuery.length).toBeGreaterThan(0);
      expect(p.regex.global).toBe(true);
    }
  });

  it("HARVEST_ATS_IDS exactly matches ATS_IDS as a set", () => {
    expect(new Set(HARVEST_ATS_IDS)).toEqual(new Set(ATS_IDS));
  });

  it("greenhouse pattern extracts the canonical /{slug} board URL", () => {
    const { regex, denyList } = harvestPatternFor("greenhouse");
    const sample =
      "https://boards.greenhouse.io/stripe/jobs/123 " +
      "https://boards.greenhouse.io/anthropic?utm=x";
    const matches = Array.from(sample.matchAll(regex)).map((m) => m[1] as string);
    expect(matches).toContain("stripe");
    expect(matches).toContain("anthropic");
    // /embed/* paths are blocked by greenhouse's robots.txt and never appear
    // in CDX; the pattern intentionally has no `embed` arm. The deny list
    // still excludes `embed` in case a stray URL matches the path-after-host.
    expect(denyList.has("embed")).toBe(true);
  });

  it("workday pattern handles wd5-impl tier subdomains", () => {
    const { regex } = harvestPatternFor("workday");
    const m = Array.from(
      "https://acme.wd5-impl.myworkdayjobs.com/External https://acme.wd1.myworkdayjobs.com".matchAll(
        regex,
      ),
    ).map((x) => x[1]);
    expect(m).toContain("acme");
    expect(m.length).toBeGreaterThanOrEqual(2);
  });

  it("successfactors pattern extracts slug from company= and host from regional cluster", () => {
    const pattern = harvestPatternFor("successfactors");
    const { regex, extractMetadata } = pattern;
    const sample =
      "https://career4.successfactors.eu/career?company=acme&career_ns=job_listing " +
      "https://career2.successfactors.com/career?career_ns=job_listing&company=widgetco";
    const re = new RegExp(regex.source, regex.flags);
    const matches = Array.from(sample.matchAll(re));
    const slugs = matches.map((m) => m[1]);
    expect(slugs).toContain("acme");
    expect(slugs).toContain("widgetco");
    // extractMetadata recovers the regional datacenter host from the
    // full match string (SF is the only ATS where slug !== host suffix,
    // so the metadata extractor is non-positional).
    expect(extractMetadata).toBeDefined();
    const meta1 = extractMetadata?.(matches[0] as RegExpExecArray);
    expect(meta1).toEqual({ host: "career4.successfactors.eu" });
    const meta2 = extractMetadata?.(matches[1] as RegExpExecArray);
    expect(meta2).toEqual({ host: "career2.successfactors.com" });
  });

  it("successfactors extractMetadata returns undefined when match[0] lacks a valid SF host", () => {
    const pattern = harvestPatternFor("successfactors");
    // Synthesize a RegExpExecArray-shaped object whose match[0] is a
    // non-SF host — the host-recovery regex inside extractMetadata
    // must fail closed.
    const fake = Object.assign(["https://evil.example.com/career?company=acme", "acme"], {
      index: 0,
      input: "https://evil.example.com/career?company=acme",
    }) as unknown as RegExpExecArray;
    expect(pattern.extractMetadata?.(fake)).toBeUndefined();
  });

  it("bamboohr pattern matches subdomain slugs", () => {
    const { regex } = harvestPatternFor("bamboohr");
    const m = Array.from("https://stripe.bamboohr.com/careers/list".matchAll(regex)).map(
      (x) => x[1],
    );
    expect(m).toContain("stripe");
  });

  it("icims pattern captures the full subdomain label as the slug", () => {
    const { regex } = harvestPatternFor("icims");
    // Real-world iCIMS hostname shapes — only ~57% start with `careers-`,
    // the rest use varied branded prefixes or composite labels.
    const sample = [
      "https://careers-example.icims.com/jobs/1234/role/job",
      "https://newprocareers-renovo.icims.com/jobs/1/x",
      "https://1stheritage-attainfinance.icims.com/",
      "https://accesssolutions-skyclimber.icims.com/jobs",
    ].join(" ");
    const m = Array.from(sample.matchAll(regex)).map((x) => x[1]);
    expect(m).toEqual(
      expect.arrayContaining([
        "careers-example",
        "newprocareers-renovo",
        "1stheritage-attainfinance",
        "accesssolutions-skyclimber",
      ]),
    );
  });

  it("icims cdxQuery uses the * domain prefix that CDX actually honors", () => {
    // CDX prefix-match semantics on URL queries are rooted at the registrable
    // domain in SURT form; wildcards inside a host segment do not work. The
    // legacy `careers-*.icims.com/*` query returned 0 records empirically.
    expect(harvestPatternFor("icims").cdxQuery).toBe("*.icims.com/*");
  });

  it("regex enforces RFC 1123 (no leading or trailing hyphen) for slugs", () => {
    const { regex } = harvestPatternFor("greenhouse");
    const noLeading = Array.from("https://boards.greenhouse.io/-bad/jobs".matchAll(regex)).map(
      (x) => x[1],
    );
    const noTrailing = Array.from("https://boards.greenhouse.io/bad-/jobs".matchAll(regex)).map(
      (x) => x[1],
    );
    expect(noLeading).not.toContain("-bad");
    expect(noTrailing).not.toContain("bad-");
  });

  it("phase-7c apparel + energy patterns extract canonical slugs", () => {
    const cases: Array<[string, string, string]> = [
      ["fastretailing", "https://www.fastretailing.com/employment/page", "fastretailing"],
      ["inditex", "https://www.inditexcareers.com/job/123", "inditex"],
      ["exxonmobil", "https://jobs.exxonmobil.com/job/123", "exxonmobil"],
      ["totalenergies", "https://careers.totalenergies.com/job/123", "totalenergies"],
      ["chevron", "https://careers.chevron.com/job/123", "chevron"],
    ];
    for (const [ats, url, expectedSlug] of cases) {
      const { regex } = harvestPatternFor(ats as Parameters<typeof harvestPatternFor>[0]);
      const re = new RegExp(regex.source, regex.flags);
      const m = re.exec(url);
      expect(m).not.toBeNull();
      expect(m?.[1]).toBe(expectedSlug);
    }
    // hmgroup and saudiaramco use metadata override for the slug.
    const hm = harvestPatternFor("hmgroup");
    const hmMatch = new RegExp(hm.regex.source, hm.regex.flags).exec("https://career.hm.com/jobs");
    expect(hm.extractMetadata?.(hmMatch as RegExpExecArray)).toEqual({ tenant: "hmgroup" });
    const aramco = harvestPatternFor("saudiaramco");
    const aramcoMatch = new RegExp(aramco.regex.source, aramco.regex.flags).exec(
      "https://careers.aramco.com/jobs",
    );
    expect(aramco.extractMetadata?.(aramcoMatch as RegExpExecArray)).toEqual({
      tenant: "saudiaramco",
    });
  });

  it("phase-7b retail patterns extract canonical slugs and metadata", () => {
    const tjPattern = harvestPatternFor("traderjoes");
    const tjMatch = new RegExp(tjPattern.regex.source, tjPattern.regex.flags).exec(
      "https://www.traderjoes.com/careers/job/123",
    );
    expect(tjMatch?.[1]).toBe("traderjoes");

    const publixPattern = harvestPatternFor("publix");
    const publixMatch = new RegExp(publixPattern.regex.source, publixPattern.regex.flags).exec(
      "https://corporate.publix.com/careers/job/123",
    );
    expect(publixMatch?.[1]).toBe("publix");

    const sevenPattern = harvestPatternFor("seveneleven");
    const sevenMatch = new RegExp(sevenPattern.regex.source, sevenPattern.regex.flags).exec(
      "https://careers.7-eleven.com/job/123",
    );
    expect(sevenMatch).not.toBeNull();
    // 7-Eleven's URL contains digits/hyphens that don't form a valid
    // tenant slug; extractMetadata supplies the canonical `seveneleven`.
    expect(sevenPattern.extractMetadata?.(sevenMatch as RegExpExecArray)).toEqual({
      tenant: "seveneleven",
    });

    const aldiPattern = harvestPatternFor("aldi");
    const aldiMatch = new RegExp(aldiPattern.regex.source, aldiPattern.regex.flags).exec(
      "https://careers.aldi.us/job/123",
    );
    expect(aldiMatch?.[1]).toBe("aldi");
  });

  it("phase-6 custom ATS patterns emit the canonical single-tenant slug", () => {
    const cases: Array<[string, string, string]> = [
      ["amazonjobs", "https://amazon.jobs/en/jobs/1234567", "amazon"],
      ["applejobs", "https://jobs.apple.com/en-us/details/200512345", "apple"],
      ["tiktokcareers", "https://careers.tiktok.com/position/7283456789/detail", "tiktok"],
      ["metacareers", "https://www.metacareers.com/jobs/1234567890/", "meta"],
      // Meta also accepts the bare host:
      ["metacareers", "https://metacareers.com/jobs", "meta"],
    ];
    for (const [ats, url, expectedSlug] of cases) {
      const { regex } = harvestPatternFor(ats as Parameters<typeof harvestPatternFor>[0]);
      const re = new RegExp(regex.source, regex.flags);
      const m = re.exec(url);
      expect(m).not.toBeNull();
      expect(m?.[1]).toBe(expectedSlug);
    }
  });

  it("throws for unknown ats id", () => {
    expect(() => harvestPatternFor("rippling" as any)).toThrow();
  });
});
