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

  it("greenhouse pattern extracts canonical /{slug} and /embed/job_app?for={slug}", () => {
    const { regex, denyList } = harvestPatternFor("greenhouse");
    const sample =
      "https://boards.greenhouse.io/stripe/jobs/123 " +
      "https://boards.greenhouse.io/anthropic?utm=x " +
      "https://boards.greenhouse.io/embed/job_app?for=acme";
    const matches = Array.from(sample.matchAll(regex)).map((m) => (m[1] ?? m[2]) as string);
    expect(matches).toContain("stripe");
    expect(matches).toContain("anthropic");
    expect(matches).toContain("acme");
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

  it("bamboohr pattern matches subdomain slugs", () => {
    const { regex } = harvestPatternFor("bamboohr");
    const m = Array.from("https://stripe.bamboohr.com/careers/list".matchAll(regex)).map(
      (x) => x[1],
    );
    expect(m).toContain("stripe");
  });

  it("icims pattern matches careers-{slug}.icims.com", () => {
    const { regex } = harvestPatternFor("icims");
    const m = Array.from(
      "https://careers-example.icims.com/jobs/1234/role/job".matchAll(regex),
    ).map((x) => x[1]);
    expect(m).toEqual(["example"]);
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

  it("throws for unknown ats id", () => {
    expect(() => harvestPatternFor("rippling" as any)).toThrow();
  });
});
