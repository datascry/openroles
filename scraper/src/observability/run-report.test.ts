import { describe, expect, it } from "bun:test";
import type { Manifest, ScrapeOutput } from "@openroles/shared";
import type { DeadTenantAlert } from "./dead-tenants.ts";
import type { DriftFinding } from "./drift.ts";
import { renderRunReport } from "./run-report.ts";

const OBSERVED_AT = "2026-04-26T00:00:00Z";

const manifest: Manifest = {
  schema_version: "1.0.0",
  built_at: OBSERVED_AT,
  short_sha: "abc1234",
  db_filename: "jobs.abc1234.sqlite",
  total_rows: 1234,
  ats_counts: {
    greenhouse: 500,
    lever: 300,
    ashby: 100,
    bamboohr: 100,
    workday: 134,
    icims: 100,
  },
  tenants_total: 50,
  tenants_live: 45,
};

function output(overrides: Partial<ScrapeOutput["metrics"]> = {}): ScrapeOutput {
  return {
    ats: "greenhouse",
    jobs: [],
    tenant_results: [],
    metrics: {
      started_at: OBSERVED_AT,
      finished_at: OBSERVED_AT,
      duration_ms: 65_000,
      requests_made: 100,
      requests_failed: 5,
      requests_retried: 3,
      bytes_received: 1_048_576,
      ...overrides,
    },
  };
}

describe("renderRunReport", () => {
  it("includes the build identity and totals", () => {
    const md = renderRunReport({ manifest, outputs: [output()] });
    expect(md).toContain("openroles run report — abc1234");
    expect(md).toContain("Schema version:** 1.0.0");
    expect(md).toContain("Jobs: **1,234**");
    expect(md).toContain("Tenants: 50 total, 45 live");
  });

  it("renders per-ATS counts in the canonical order", () => {
    const md = renderRunReport({ manifest, outputs: [] });
    const order = ["greenhouse", "lever", "ashby", "bamboohr", "workday", "icims"];
    for (let i = 1; i < order.length; i++) {
      const a = order[i - 1];
      const b = order[i];
      if (a === undefined || b === undefined) throw new Error("undefined");
      expect(md.indexOf(`| ${a} |`)).toBeLessThan(md.indexOf(`| ${b} |`));
    }
  });

  it("aggregates request counters across outputs", () => {
    const md = renderRunReport({
      manifest,
      outputs: [
        output({ requests_made: 100, requests_failed: 5, requests_retried: 3 }),
        output({ requests_made: 50, requests_failed: 2, requests_retried: 1 }),
      ],
    });
    expect(md).toContain("Requests: 150 (failed 7, retried 4)");
  });

  it("notes 'no drift findings' when none are passed", () => {
    const md = renderRunReport({ manifest, outputs: [] });
    expect(md).toContain("_No drift findings._");
  });

  it("renders drift findings with severity prefixes", () => {
    const drift: DriftFinding[] = [
      { severity: "error", code: "total-rows-drop", message: "1000 → 600" },
      { severity: "warn", code: "schema-version-changed", message: "1.0.0 → 1.1.0" },
      { severity: "info", code: "first-build", message: "fresh start" },
    ];
    const md = renderRunReport({ manifest, outputs: [], drift });
    expect(md).toContain("[ERROR] `total-rows-drop` — 1000 → 600");
    expect(md).toContain("[WARN] `schema-version-changed`");
    expect(md).toContain("[info] `first-build`");
  });

  it("notes 'no dead tenants' when the list is empty", () => {
    const md = renderRunReport({ manifest, outputs: [] });
    expect(md).toContain("_No tenants exceed the consecutive-dead threshold._");
  });

  it("renders dead-tenant alerts as a table", () => {
    const dead: DeadTenantAlert[] = [
      {
        ats: "greenhouse",
        slug: "alpha",
        consecutive_dead: 3,
        first_seen_dead_at: "2026-03-01T00:00:00Z",
        last_seen_dead_at: "2026-04-01T00:00:00Z",
      },
    ];
    const md = renderRunReport({ manifest, outputs: [], deadTenants: dead });
    expect(md).toContain(
      "| greenhouse | alpha | 3 | 2026-03-01T00:00:00Z | 2026-04-01T00:00:00Z |",
    );
  });

  it("formats sub-second, sub-minute, and minute durations", () => {
    const a = renderRunReport({
      manifest,
      outputs: [output({ duration_ms: 750 })],
    });
    expect(a).toContain("Wall time: 750ms");
    const b = renderRunReport({
      manifest,
      outputs: [output({ duration_ms: 12_500 })],
    });
    expect(b).toContain("Wall time: 12.5s");
    const c = renderRunReport({
      manifest,
      outputs: [output({ duration_ms: 125_000 })],
    });
    expect(c).toContain("Wall time: 2m 5s");
  });

  it("treats negative or non-finite durations as 0s", () => {
    const md = renderRunReport({
      manifest,
      outputs: [output({ duration_ms: Number.NaN })],
    });
    expect(md).toContain("Wall time: 0s");
  });

  it("ends with a trailing newline", () => {
    const md = renderRunReport({ manifest, outputs: [] });
    expect(md.endsWith("\n")).toBe(true);
  });
});
