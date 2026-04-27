import { describe, expect, it } from "bun:test";
import { ATS_IDS, ATSIdSchema } from "./ats.ts";

describe("ATSIdSchema", () => {
  it("accepts each canonical ATS id", () => {
    for (const id of ATS_IDS) {
      expect(ATSIdSchema.parse(id)).toBe(id);
    }
  });

  it("rejects unknown ATS ids", () => {
    expect(() => ATSIdSchema.parse("not-an-ats")).toThrow();
  });

  it("rejects non-strings", () => {
    expect(() => ATSIdSchema.parse(42)).toThrow();
    expect(() => ATSIdSchema.parse(null)).toThrow();
  });

  it("freezes the canonical list", () => {
    expect(Object.isFrozen(ATS_IDS)).toBe(true);
  });
});
