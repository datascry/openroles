import { describe, expect, it } from "bun:test";
import fc from "fast-check";
import { classifyRecruiter } from "./recruiter.ts";

describe("classifyRecruiter", () => {
  it("flags titles with explicit recruiter keywords", () => {
    expect(classifyRecruiter({ title: "Technical Recruiter" })).toBe(true);
    expect(classifyRecruiter({ title: "Senior Recruiter, Engineering" })).toBe(true);
    expect(classifyRecruiter({ title: "Engineering Sourcer" })).toBe(true);
    expect(classifyRecruiter({ title: "Talent Acquisition Partner" })).toBe(true);
    expect(classifyRecruiter({ title: "Talent Sourcing Lead" })).toBe(true);
    expect(classifyRecruiter({ title: "Head of Talent" })).toBe(true);
  });

  it("flags non-engineering titles in talent / people-ops departments", () => {
    expect(classifyRecruiter({ title: "Coordinator", department: "Talent" })).toBe(true);
    expect(
      classifyRecruiter({ title: "Operations Manager", department: "Talent Acquisition" }),
    ).toBe(true);
    expect(classifyRecruiter({ title: "People Partner", department: "People" })).toBe(true);
  });

  it("flags 'Engineering Coordinator' in a Talent dept (engineering modifier, not head)", () => {
    expect(classifyRecruiter({ title: "Engineering Coordinator", department: "Talent" })).toBe(
      true,
    );
    expect(
      classifyRecruiter({ title: "Engineering Recruiting Coordinator", department: "People" }),
    ).toBe(true);
  });

  it("does not flag engineering titles even in adjacent departments", () => {
    expect(classifyRecruiter({ title: "Software Engineer", department: "Engineering" })).toBe(
      false,
    );
    expect(classifyRecruiter({ title: "Staff Engineer", department: "Talent" })).toBe(false);
  });

  it("does not flag engineering manager / director titles", () => {
    expect(classifyRecruiter({ title: "Engineering Manager" })).toBe(false);
    expect(classifyRecruiter({ title: "Director of Engineering" })).toBe(false);
  });

  it("returns false for empty / whitespace input", () => {
    expect(classifyRecruiter({ title: "" })).toBe(false);
    expect(classifyRecruiter({ title: "   " })).toBe(false);
  });

  it("is deterministic on identical input", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 80 }), fc.option(fc.string({ maxLength: 40 })), (t, d) => {
        const i = { title: t, ...(d ? { department: d } : {}) };
        const a = classifyRecruiter(i);
        const b = classifyRecruiter(i);
        return a === b;
      }),
      { numRuns: 100 },
    );
  });
});
