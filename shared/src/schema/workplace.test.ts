import { describe, expect, it } from "bun:test";
import { WORKPLACE_TYPES, WorkplaceTypeSchema } from "./workplace.ts";

describe("WorkplaceTypeSchema", () => {
  it("accepts each canonical workplace type and null", () => {
    for (const wt of WORKPLACE_TYPES) {
      expect(WorkplaceTypeSchema.parse(wt)).toBe(wt);
    }
    expect(WorkplaceTypeSchema.parse(null)).toBeNull();
  });

  it("rejects unknown values", () => {
    expect(() => WorkplaceTypeSchema.parse("anywhere")).toThrow();
    expect(() => WorkplaceTypeSchema.parse(undefined)).toThrow();
  });
});
