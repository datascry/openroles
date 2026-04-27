import { describe, expect, it } from "bun:test";
import fc from "fast-check";
import { LEVELS } from "../schema/level.ts";
import { classifyLevel } from "./level.ts";

describe("classifyLevel", () => {
  const cases: Array<[string, ReturnType<typeof classifyLevel>]> = [
    ["Software Engineering Intern", "intern"],
    ["Summer Intern, Engineering", "intern"],
    ["Associate Software Engineer", "entry"],
    ["New Grad Software Engineer", "entry"],
    ["Entry-Level Backend Engineer", "entry"],
    ["Graduate Engineer", "entry"],
    ["Graduate Studies Coordinator", null],
    ["Graduate of Stanford", null],
    ["Junior Frontend Engineer", "junior"],
    ["Jr. Software Engineer", "junior"],
    ["Software Engineer II", "mid"],
    ["Software Engineer III", "mid"],
    ["Engineer 2", "mid"],
    ["Engineer 3", "mid"],
    ["Software Engineer IV", "mid"],
    ["Engineer V", "mid"],
    ["Customer 3", null],
    ["Tier 2 Operator", null],
    ["Vice President 3", null],
    ["Senior Software Engineer", "senior"],
    ["Sr. Backend Engineer", "senior"],
    ["Staff Software Engineer", "staff"],
    ["Principal Engineer", "principal"],
    ["Lead Data Engineer", "lead"],
    ["Lead Frontend Engineer", "lead"],
    ["Tech Lead, Platform", "lead"],
    ["Engineering Lead", "lead"],
    ["Lead, Engineering", "lead"],
    ["Engineering Manager", "manager"],
    ["Senior Engineering Manager", "manager"],
    ["Engineering Director", "director"],
    ["Head of Engineering", "director"],
    ["Director of Product", "director"],
    ["Senior Director, Platform", "director"],
    ["Software Engineer", null],
    ["", null],
  ];

  for (const [title, expected] of cases) {
    it(`maps ${JSON.stringify(title)} to ${String(expected)}`, () => {
      expect(classifyLevel(title)).toBe(expected);
    });
  }

  it("director outranks senior in conflicting titles", () => {
    expect(classifyLevel("Senior Director, Engineering")).toBe("director");
  });

  it("manager outranks senior in conflicting titles", () => {
    expect(classifyLevel("Senior Engineering Manager")).toBe("manager");
  });

  it("returns null for empty / whitespace input", () => {
    expect(classifyLevel("   ")).toBeNull();
  });

  it("does not misclassify 'Lead Generation' or 'Sales Lead' as lead", () => {
    expect(classifyLevel("Lead Generation Specialist")).toBeNull();
    expect(classifyLevel("Sales Lead")).toBeNull();
  });

  it("does not misclassify 'Associate Director' as entry (director wins)", () => {
    expect(classifyLevel("Associate Director, Engineering")).toBe("director");
  });

  it("does not misclassify ambiguous 'Sales Associate' as entry", () => {
    expect(classifyLevel("Sales Associate")).toBeNull();
  });

  it("only ever returns a value from the canonical Level set", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 80 }), (s) => {
        const result = classifyLevel(s);
        return result === null || (LEVELS as ReadonlyArray<unknown>).includes(result);
      }),
      { numRuns: 200 },
    );
  });

  it("is deterministic on identical input", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 80 }), (s) => {
        const a = classifyLevel(s);
        const b = classifyLevel(s);
        return a === b;
      }),
      { numRuns: 100 },
    );
  });
});
