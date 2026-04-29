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

  it("rejects db_filename outside the canonical jobs.{sha}.sqlite[.gz] shape", () => {
    const bad = ["x", "jobs.abc.sqlite", "jobs.abc1234.csv", "jobs.abc1234.sqlite|inject"];
    for (const filename of bad) {
      expect(() =>
        ManifestSchema.parse({
          schema_version: "1.0.0",
          built_at: "2026-04-26T00:00:00Z",
          short_sha: "abc1234",
          db_filename: filename,
          total_rows: 0,
          ats_counts: {
            greenhouse: 0,
            lever: 0,
            ashby: 0,
            bamboohr: 0,
            workday: 0,
            icims: 0,
          },
          tenants_total: 0,
          tenants_live: 0,
        }),
      ).toThrow();
    }
  });

  it("accepts both jobs.{sha}.sqlite and jobs.{sha}.sqlite.gz", () => {
    for (const filename of ["jobs.abc1234.sqlite", "jobs.abc1234.sqlite.gz"]) {
      expect(() =>
        ManifestSchema.parse({
          schema_version: "1.0.0",
          built_at: "2026-04-26T00:00:00Z",
          short_sha: "abc1234",
          db_filename: filename,
          total_rows: 0,
          ats_counts: {
            greenhouse: 0,
            lever: 0,
            ashby: 0,
            bamboohr: 0,
            workday: 0,
            icims: 0,
          },
          tenants_total: 0,
          tenants_live: 0,
        }),
      ).not.toThrow();
    }
  });

  it("fills missing ats_counts keys with zero (forward-compat for older manifests)", () => {
    // Schema 1.1.0 widened ATS_IDS from 6 to 12; manifests written by 1.0.0
    // build-db only carry the original 6 keys. Defaults fill the rest so old
    // artifacts remain readable.
    const m = ManifestSchema.parse({
      schema_version: "1.0.0",
      built_at: "2026-04-26T00:00:00Z",
      short_sha: "a3f2b1c",
      db_filename: "jobs.a3f2b1c.sqlite.gz",
      total_rows: 100,
      ats_counts: { greenhouse: 100 },
      tenants_total: 50,
      tenants_live: 45,
    });
    expect(m.ats_counts.greenhouse).toBe(100);
    expect(m.ats_counts.recruitee).toBe(0);
    expect(m.ats_counts.smartrecruiters).toBe(0);
  });

  it("rejects ats_counts containing an unknown ATS key (strict catches typos)", () => {
    expect(() =>
      ManifestSchema.parse({
        schema_version: "1.0.0",
        built_at: "2026-04-26T00:00:00Z",
        short_sha: "a3f2b1c",
        db_filename: "jobs.a3f2b1c.sqlite.gz",
        total_rows: 100,
        ats_counts: { greenhouse: 100, greenhuose: 0 },
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

  it("defaults Phase 12 fields when missing (forward-compat for pre-1.3.0 manifests)", () => {
    const m = ManifestSchema.parse({
      schema_version: "1.2.0",
      built_at: "2026-04-26T00:00:00Z",
      short_sha: "a3f2b1c",
      db_filename: "jobs.a3f2b1c.sqlite",
      total_rows: 0,
      ats_counts: {},
      tenants_total: 0,
      tenants_live: 0,
    });
    expect(m.fresh_count).toBe(0);
    expect(m.stale_count).toBe(0);
    expect(m.stale_ttl_days).toBe(3);
  });

  it("rejects fresh_count + stale_count != total_rows when both are populated", () => {
    expect(() =>
      ManifestSchema.parse({
        schema_version: "1.3.0",
        built_at: "2026-04-26T00:00:00Z",
        short_sha: "a3f2b1c",
        db_filename: "jobs.a3f2b1c.sqlite",
        total_rows: 100,
        ats_counts: { greenhouse: 100 },
        tenants_total: 1,
        tenants_live: 1,
        fresh_count: 60,
        stale_count: 30,
        stale_ttl_days: 3,
      }),
    ).toThrow();
  });

  it("accepts fresh_count + stale_count == total_rows", () => {
    expect(() =>
      ManifestSchema.parse({
        schema_version: "1.3.0",
        built_at: "2026-04-26T00:00:00Z",
        short_sha: "a3f2b1c",
        db_filename: "jobs.a3f2b1c.sqlite",
        total_rows: 100,
        ats_counts: { greenhouse: 100 },
        tenants_total: 1,
        tenants_live: 1,
        fresh_count: 80,
        stale_count: 20,
        stale_ttl_days: 3,
      }),
    ).not.toThrow();
  });
});
