import { describe, expect, it } from "bun:test";
import { ManifestSchema } from "./manifest.ts";

describe("ManifestSchema", () => {
  it("accepts a complete manifest", () => {
    const m = ManifestSchema.parse({
      schema_version: "1.0.0",
      built_at: "2026-04-26T00:00:00Z",
      short_sha: "a3f2b1c",
      db_filename: "jobs.a3f2b1c.sqlite.gz",
      total_rows: 100,
      ats_counts: {
        greenhouse: 40,
        lever: 20,
        ashby: 10,
        bamboohr: 10,
        workday: 15,
        icims: 5,
      },
      tenants_total: 50,
      tenants_live: 45,
    });
    expect(m.total_rows).toBe(100);
  });

  it("rejects ats_counts missing a required ATS key", () => {
    expect(() =>
      ManifestSchema.parse({
        schema_version: "1.0.0",
        built_at: "2026-04-26T00:00:00Z",
        short_sha: "a3f2b1c",
        db_filename: "jobs.a3f2b1c.sqlite.gz",
        total_rows: 100,
        ats_counts: { greenhouse: 100 },
        tenants_total: 50,
        tenants_live: 45,
      }),
    ).toThrow();
  });

  it("rejects ats_counts sum disagreeing with total_rows", () => {
    expect(() =>
      ManifestSchema.parse({
        schema_version: "1.0.0",
        built_at: "2026-04-26T00:00:00Z",
        short_sha: "a3f2b1c",
        db_filename: "jobs.a3f2b1c.sqlite.gz",
        total_rows: 99,
        ats_counts: {
          greenhouse: 40,
          lever: 20,
          ashby: 10,
          bamboohr: 10,
          workday: 15,
          icims: 5,
        },
        tenants_total: 50,
        tenants_live: 45,
      }),
    ).toThrow();
  });

  it("rejects tenants_live > tenants_total", () => {
    expect(() =>
      ManifestSchema.parse({
        schema_version: "1.0.0",
        built_at: "2026-04-26T00:00:00Z",
        short_sha: "a3f2b1c",
        db_filename: "jobs.a3f2b1c.sqlite.gz",
        total_rows: 0,
        ats_counts: {
          greenhouse: 0,
          lever: 0,
          ashby: 0,
          bamboohr: 0,
          workday: 0,
          icims: 0,
        },
        tenants_total: 1,
        tenants_live: 5,
      }),
    ).toThrow();
  });
});
