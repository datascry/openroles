import { describe, expect, it } from "bun:test";
import { atsLong, atsShort } from "./ats-pretty.ts";

describe("ats-pretty", () => {
  it("returns long-form labels for known ats ids", () => {
    expect(atsLong("greenhouse")).toBe("Greenhouse");
    expect(atsLong("smartrecruiters")).toBe("SmartRecruiters");
    expect(atsLong("csod")).toBe("Cornerstone");
  });

  it("returns short-form labels for known ats ids", () => {
    expect(atsShort("greenhouse")).toBe("GH");
    expect(atsShort("smartrecruiters")).toBe("SMARTREC");
    expect(atsShort("csod")).toBe("CORNERSTONE");
  });

  it("falls back to the raw id for unknown ats long labels", () => {
    expect(atsLong("unknown-ats")).toBe("unknown-ats");
  });

  it("falls back to upper-cased id for unknown short labels", () => {
    expect(atsShort("unknown-ats")).toBe("UNKNOWN-ATS");
  });
});
