import { describe, expect, it } from "bun:test";
import type { Manifest } from "@openroles/shared";
import { DEFAULT_DRIFT_THRESHOLDS, detectDrift, maxSeverity } from "./drift.ts";

const OBSERVED_AT = "2026-04-26T00:00:00Z";

function manifest(overrides: Partial<Manifest> = {}): Manifest {
  const base: Manifest = {
    schema_version: "1.0.0",
    built_at: OBSERVED_AT,
    short_sha: "abc1234",
    db_filename: "jobs.abc1234.sqlite",
    total_rows: 1000,
    ats_counts: {
      greenhouse: 400,
      lever: 200,
      ashby: 100,
      bamboohr: 100,
      workday: 100,
      icims: 100,
    },
    tenants_total: 100,
    tenants_live: 90,
  };
  return { ...base, ...overrides };
}

describe("detectDrift", () => {
  it("emits a single 'first-build' finding when there is no previous manifest", () => {
    const findings = detectDrift(null, manifest());
    expect(findings).toHaveLength(1);
    expect(findings[0]?.code).toBe("first-build");
    expect(findings[0]?.severity).toBe("info");
  });

  it("emits no findings when nothing meaningful changed", () => {
    const findings = detectDrift(manifest(), manifest());
    expect(findings).toEqual([]);
  });

  it("warns on a 10–25% total_rows drop and errors above 25%", () => {
    const w = detectDrift(manifest({ total_rows: 1000 }), manifest({ total_rows: 850 }));
    expect(w.find((f) => f.code === "total-rows-drop")?.severity).toBe("warn");
    const e = detectDrift(manifest({ total_rows: 1000 }), manifest({ total_rows: 600 }));
    expect(e.find((f) => f.code === "total-rows-drop")?.severity).toBe("error");
  });

  it("flags an ats count zeroing as error", () => {
    const findings = detectDrift(
      manifest(),
      manifest({
        total_rows: 600,
        ats_counts: {
          greenhouse: 0,
          lever: 200,
          ashby: 100,
          bamboohr: 100,
          workday: 100,
          icims: 100,
        },
      }),
    );
    expect(findings.find((f) => f.code === "ats-count-zeroed")?.severity).toBe("error");
  });

  it("warns on a per-ATS drop above the warn threshold", () => {
    const findings = detectDrift(
      manifest(),
      manifest({
        total_rows: 700,
        ats_counts: {
          greenhouse: 100,
          lever: 200,
          ashby: 100,
          bamboohr: 100,
          workday: 100,
          icims: 100,
        },
      }),
    );
    const ghDrop = findings.find((f) => f.code === "ats-drop:greenhouse");
    expect(ghDrop).toBeDefined();
    expect(ghDrop?.severity).toBe("error");
  });

  it("warns on tenants_live drop", () => {
    const findings = detectDrift(manifest(), manifest({ tenants_live: 60 }));
    expect(findings.find((f) => f.code === "tenants-live-drop")?.severity).toBe("error");
  });

  it("flags schema_version changes as warn", () => {
    const findings = detectDrift(manifest(), manifest({ schema_version: "1.1.0" }));
    expect(findings.find((f) => f.code === "schema-version-changed")?.severity).toBe("warn");
  });

  it("ignores increases (no findings on growth)", () => {
    const findings = detectDrift(manifest(), manifest({ total_rows: 5000 }));
    expect(findings).toEqual([]);
  });

  it("respects custom thresholds", () => {
    const tighter = {
      ...DEFAULT_DRIFT_THRESHOLDS,
      totalRowsDropFractionWarn: 0.01,
      totalRowsDropFractionError: 0.99,
    };
    const findings = detectDrift(
      manifest({ total_rows: 1000 }),
      manifest({ total_rows: 990 }),
      tighter,
    );
    expect(findings.find((f) => f.code === "total-rows-drop")?.severity).toBe("warn");
  });
});

describe("maxSeverity", () => {
  it("returns info for an empty list", () => {
    expect(maxSeverity([])).toBe("info");
  });

  it("returns warn when warns are present but no errors", () => {
    expect(
      maxSeverity([
        { severity: "info", code: "x", message: "" },
        { severity: "warn", code: "y", message: "" },
      ]),
    ).toBe("warn");
  });

  it("returns error when any error is present", () => {
    expect(
      maxSeverity([
        { severity: "warn", code: "y", message: "" },
        { severity: "error", code: "z", message: "" },
      ]),
    ).toBe("error");
  });
});
