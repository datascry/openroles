import { describe, expect, it } from "bun:test";
import * as fc from "fast-check";
import { classifyWorkplace } from "./workplace.ts";

describe("classifyWorkplace", () => {
  it("returns null for empty inputs", () => {
    expect(classifyWorkplace({ title: "" })).toBeNull();
    expect(classifyWorkplace({ title: "   " })).toBeNull();
  });

  it("returns null when no signal in any field", () => {
    expect(
      classifyWorkplace({
        title: "Senior Software Engineer",
        location_text: "London, UK",
        description_excerpt: "Build cool things.",
      }),
    ).toBeNull();
  });

  it("detects remote from title", () => {
    expect(classifyWorkplace({ title: "Remote Software Engineer" })).toBe("remote");
  });

  it("detects remote from location", () => {
    expect(
      classifyWorkplace({
        title: "Software Engineer",
        location_text: "Remote, US",
      }),
    ).toBe("remote");
  });

  it("detects remote from description", () => {
    expect(
      classifyWorkplace({
        title: "Engineer",
        description_excerpt: "This is a fully remote position based anywhere in the US.",
      }),
    ).toBe("remote");
  });

  it("detects WFH and telecommute synonyms", () => {
    expect(classifyWorkplace({ title: "WFH Engineer" })).toBe("remote");
    expect(classifyWorkplace({ title: "Engineer (Telecommute)" })).toBe("remote");
  });

  it("returns hybrid when both 'hybrid' and 'remote' appear", () => {
    expect(
      classifyWorkplace({
        title: "Engineer",
        description_excerpt: "Hybrid role — 3 days a week in office, 2 days remote.",
      }),
    ).toBe("hybrid");
  });

  it("detects hybrid from a 'N days/week' pattern alone", () => {
    expect(
      classifyWorkplace({
        title: "Engineer",
        description_excerpt: "We work 3 days per week in the office.",
      }),
    ).toBe("hybrid");
  });

  it("detects onsite", () => {
    expect(classifyWorkplace({ title: "Onsite Lab Engineer" })).toBe("onsite");
    expect(classifyWorkplace({ title: "Engineer", location_text: "In-office, NYC" })).toBe(
      "onsite",
    );
  });

  describe("invariants", () => {
    it("never throws", () => {
      fc.assert(
        fc.property(fc.string(), fc.option(fc.string()), fc.option(fc.string()), (t, l, d) => {
          classifyWorkplace({
            title: t,
            ...(l !== null ? { location_text: l } : {}),
            ...(d !== null ? { description_excerpt: d } : {}),
          });
        }),
      );
    });

    it("returns one of the four legal values", () => {
      fc.assert(
        fc.property(fc.string(), (t) => {
          const result = classifyWorkplace({ title: t });
          expect([null, "remote", "hybrid", "onsite"]).toContain(result);
        }),
      );
    });
  });
});
