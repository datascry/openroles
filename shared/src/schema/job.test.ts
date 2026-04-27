import { describe, expect, it } from "bun:test";
import { JobSchema } from "./job.ts";

const baseJob = {
  id: "a".repeat(64),
  ats: "greenhouse",
  tenant_slug: "stripe",
  source_id: "5839271",
  title: "Senior Software Engineer",
  company: "Stripe",
  level: "senior",
  level_rank: 4,
  workplace_type: "hybrid",
  is_recruiter_post: false,
  first_seen_at: "2026-04-22T18:00:00Z",
  last_seen_at: "2026-04-26T00:00:00Z",
  url: "https://boards.greenhouse.io/stripe/jobs/5839271",
};

describe("JobSchema", () => {
  it("accepts a canonical Job with required fields only", () => {
    const job = JobSchema.parse(baseJob);
    expect(job.id).toBe(baseJob.id);
    expect(job.level_rank).toBe(4);
  });

  it("accepts a Job with optional fields populated", () => {
    const full = {
      ...baseJob,
      description_excerpt: "Build payment systems...",
      location_text: "San Francisco, CA",
      location_country: "US",
      location_region: "CA",
      compensation_min: 18000000,
      compensation_max: 25000000,
      compensation_currency: "USD",
      department: "Engineering",
      posted_at: "2026-04-22T17:14:00Z",
      updated_at: "2026-04-25T09:03:00Z",
    };
    const parsed = JobSchema.parse(full);
    expect(parsed.compensation_currency).toBe("USD");
  });

  it("rejects empty title", () => {
    expect(() => JobSchema.parse({ ...baseJob, title: "" })).toThrow();
    expect(() => JobSchema.parse({ ...baseJob, title: "   " })).toThrow();
  });

  it("rejects empty company / id / url", () => {
    expect(() => JobSchema.parse({ ...baseJob, company: "" })).toThrow();
    expect(() => JobSchema.parse({ ...baseJob, id: "" })).toThrow();
    expect(() => JobSchema.parse({ ...baseJob, url: "" })).toThrow();
  });

  it("rejects non-http(s) URL schemes (javascript:, data:, file:) — XSS guard", () => {
    // <a href={row.url}> renders this directly; the scheme guard closes the
    // class of injection that would let a recruiter-controlled job description
    // bridge into one-click XSS on the deployed site.
    for (const u of [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      "data:text/html,<x>",
      "file:///etc/passwd",
      "vbscript:msgbox('x')",
    ]) {
      expect(() => JobSchema.parse({ ...baseJob, url: u })).toThrow();
    }
  });

  it("rejects compensation_min > compensation_max", () => {
    expect(() =>
      JobSchema.parse({
        ...baseJob,
        compensation_min: 1000,
        compensation_max: 500,
        compensation_currency: "USD",
      }),
    ).toThrow();
  });

  it("rejects posted_at later than last_seen_at", () => {
    expect(() =>
      JobSchema.parse({
        ...baseJob,
        posted_at: "2026-05-01T00:00:00Z",
      }),
    ).toThrow();
  });

  it("rejects unknown ATSId", () => {
    expect(() => JobSchema.parse({ ...baseJob, ats: "rippling" })).toThrow();
  });

  it("rejects unknown Level", () => {
    expect(() => JobSchema.parse({ ...baseJob, level: "architect" })).toThrow();
  });

  it("rejects non-ISO 4217 currency", () => {
    expect(() =>
      JobSchema.parse({
        ...baseJob,
        compensation_min: 100,
        compensation_max: 200,
        compensation_currency: "DOLLARS",
      }),
    ).toThrow();
    expect(() =>
      JobSchema.parse({
        ...baseJob,
        compensation_min: 100,
        compensation_max: 200,
        compensation_currency: "us",
      }),
    ).toThrow();
  });

  it("rejects non-integer compensation values", () => {
    expect(() =>
      JobSchema.parse({
        ...baseJob,
        compensation_min: 100.5,
        compensation_max: 200,
        compensation_currency: "USD",
      }),
    ).toThrow();
  });

  it("rejects level_rank disagreeing with level", () => {
    expect(() =>
      JobSchema.parse({
        ...baseJob,
        level: "senior",
        level_rank: 0,
      }),
    ).toThrow();
  });

  it("requires level_rank to be null when level is null", () => {
    const ok = JobSchema.parse({ ...baseJob, level: null, level_rank: null });
    expect(ok.level_rank).toBeNull();
    expect(() => JobSchema.parse({ ...baseJob, level: null, level_rank: 4 })).toThrow();
  });

  it("rejects bogus country/region casing or length", () => {
    expect(() => JobSchema.parse({ ...baseJob, location_country: "USA" })).toThrow();
    expect(() => JobSchema.parse({ ...baseJob, location_country: "us" })).toThrow();
  });

  it("rejects bogus id (not 64-char hex)", () => {
    expect(() => JobSchema.parse({ ...baseJob, id: "not-hex" })).toThrow();
    expect(() => JobSchema.parse({ ...baseJob, id: "g".repeat(64) })).toThrow();
  });

  it("rejects updated_at later than last_seen_at", () => {
    expect(() =>
      JobSchema.parse({
        ...baseJob,
        updated_at: "2026-05-01T00:00:00Z",
      }),
    ).toThrow();
  });

  it("rejects first_seen_at later than last_seen_at", () => {
    expect(() =>
      JobSchema.parse({
        ...baseJob,
        first_seen_at: "2026-05-01T00:00:00Z",
      }),
    ).toThrow();
  });

  it("rejects control characters in title across all banned ranges", () => {
    const codePoints = [0x00, 0x07, 0x08, 0x0b, 0x0c, 0x0e, 0x1f, 0x7f];
    for (const code of codePoints) {
      const c = String.fromCharCode(code);
      expect(() => JobSchema.parse({ ...baseJob, title: `Senior${c}Engineer` })).toThrow();
    }
  });

  it("permits tab and newline in title (safelisted whitespace)", () => {
    expect(() => JobSchema.parse({ ...baseJob, title: "Senior\tEngineer\nReality" })).not.toThrow();
  });

  it("rejects whitespace-only description_excerpt", () => {
    expect(() => JobSchema.parse({ ...baseJob, description_excerpt: "   \t\n   " })).toThrow();
  });

  it("rejects oversized title", () => {
    expect(() => JobSchema.parse({ ...baseJob, title: "x".repeat(2000) })).toThrow();
  });

  it("rejects compensation values above the absolute cap", () => {
    expect(() =>
      JobSchema.parse({
        ...baseJob,
        compensation_min: 100_000_000_000_000,
        compensation_max: 200_000_000_000_000,
        compensation_currency: "USD",
      }),
    ).toThrow();
  });

  it("rejects oversized location_text and department", () => {
    expect(() => JobSchema.parse({ ...baseJob, location_text: "x".repeat(3000) })).toThrow();
    expect(() => JobSchema.parse({ ...baseJob, department: "x".repeat(3000) })).toThrow();
  });

  it("rejects oversized description_excerpt", () => {
    expect(() => JobSchema.parse({ ...baseJob, description_excerpt: "x".repeat(5000) })).toThrow();
  });
});
