import { describe, expect, it } from "bun:test";
import { bylineParts, pullquote, type RoleForFormat } from "./role-detail-format.ts";

const baseRole: RoleForFormat = {
  ats: "greenhouse",
  title: "Senior Software Engineer",
  company: "Stripe",
  description_excerpt: "Build the future.",
  level: "senior",
  workplace_type: "remote",
  department: "engineering",
  location_text: "US, EU",
  compensation_min: 220_000,
  compensation_max: 290_000,
  compensation_currency: "USD",
};

describe("bylineParts", () => {
  it("emits level, workplace+location, department, comp, ats in order", () => {
    const parts = bylineParts(baseRole);
    const values = parts.map((p) => p.value);
    expect(values).toEqual(["SENIOR", "REMOTE (US, EU)", "ENGINEERING", "$220K – $290K", "GH"]);
  });

  it("uses location alone when workplace_type is null", () => {
    const role: RoleForFormat = { ...baseRole, workplace_type: null };
    const parts = bylineParts(role);
    expect(parts.map((p) => p.value)).toContain("US, EU");
  });

  it("suppresses location_text when it would just duplicate workplace_type", () => {
    const role: RoleForFormat = {
      ...baseRole,
      workplace_type: "remote",
      location_text: "Remote",
    };
    const parts = bylineParts(role);
    expect(parts.map((p) => p.value)).toContain("REMOTE");
    expect(parts.map((p) => p.value)).not.toContain("REMOTE (REMOTE)");
  });

  it("drops missing fields cleanly", () => {
    const role: RoleForFormat = {
      ...baseRole,
      level: null,
      workplace_type: null,
      department: null,
      location_text: null,
      compensation_min: null,
      compensation_max: null,
    };
    const parts = bylineParts(role);
    expect(parts.map((p) => p.value)).toEqual(["GH"]);
  });

  it("falls back to upper-case ats id when not in ATS_PRETTY", () => {
    const role: RoleForFormat = { ...baseRole, ats: "myats" };
    const parts = bylineParts(role);
    expect(parts[parts.length - 1]?.value).toBe("MYATS");
  });
});

describe("pullquote", () => {
  it("renders a both-sided comp band", () => {
    const out = pullquote(baseRole);
    expect(out?.quote).toBe("$220K – $290K");
    expect(out?.sub).toContain("Posted band");
    expect(out?.sub).toContain("USD");
  });

  it("renders 'From $X' when only min is set", () => {
    const role: RoleForFormat = { ...baseRole, compensation_max: null };
    expect(pullquote(role)?.quote).toMatch(/From \$220K/);
  });

  it("renders 'Up to $Y' when only max is set", () => {
    const role: RoleForFormat = { ...baseRole, compensation_min: null };
    expect(pullquote(role)?.quote).toMatch(/Up to \$290K/);
  });

  it("returns null when both comp values are null", () => {
    const role: RoleForFormat = {
      ...baseRole,
      compensation_min: null,
      compensation_max: null,
    };
    expect(pullquote(role)).toBeNull();
  });

  it("does not append + EQUITY when description doesn't mention it", () => {
    const role: RoleForFormat = { ...baseRole, description_excerpt: "no e-word here" };
    expect(pullquote(role)?.quote).toBe("$220K – $290K");
  });

  it("appends + EQUITY when description mentions equity (case-insensitive)", () => {
    const role: RoleForFormat = {
      ...baseRole,
      description_excerpt: "Generous Equity grant",
    };
    expect(pullquote(role)?.quote).toBe("$220K – $290K + EQUITY");
  });

  it("treats null description as no-equity", () => {
    const role: RoleForFormat = { ...baseRole, description_excerpt: null };
    expect(pullquote(role)?.quote).toBe("$220K – $290K");
  });

  it("omits currency from sub when unset", () => {
    const role: RoleForFormat = { ...baseRole, compensation_currency: null };
    const out = pullquote(role);
    expect(out?.sub).not.toContain("USD");
  });

  it("formats sub-1000 comp values without the K suffix", () => {
    const role: RoleForFormat = {
      ...baseRole,
      compensation_min: 500,
      compensation_max: 900,
    };
    const out = pullquote(role);
    expect(out?.quote).toBe("$500 – $900");
  });
});
