import { describe, expect, it } from "bun:test";
import { JobSchema } from "@openroles/shared";
import { buildJob } from "./build-job.ts";

const baseInput = {
  ats: "greenhouse" as const,
  tenant_slug: "stripe",
  company: "Stripe",
  source_id: "5839271",
  title: "Senior Software Engineer",
  url: "https://boards.greenhouse.io/stripe/jobs/5839271",
  first_seen_at: "2026-04-22T18:00:00Z",
  last_seen_at: "2026-04-26T00:00:00Z",
};

describe("buildJob", () => {
  it("produces a Job that round-trips through JobSchema", () => {
    const job = buildJob(baseInput);
    expect(() => JobSchema.parse(job)).not.toThrow();
  });

  it("derives a deterministic id from (ats, slug, source_id, url)", () => {
    expect(buildJob(baseInput).id).toBe(buildJob(baseInput).id);
  });

  it("populates description_excerpt from description_html", () => {
    const job = buildJob({
      ...baseInput,
      description_html: "<p>Build <b>payment</b> systems.</p>",
    });
    expect(job.description_excerpt).toBe("Build payment systems.");
  });

  it("uses description_text when provided directly", () => {
    const job = buildJob({
      ...baseInput,
      description_text: "Direct text body.",
    });
    expect(job.description_excerpt).toBe("Direct text body.");
  });

  it("splits location into country/region when shape allows", () => {
    const job = buildJob({
      ...baseInput,
      location_text: "Austin, TX, US",
    });
    expect(job.location_country).toBe("US");
    expect(job.location_region).toBe("TX");
  });

  it("infers workplace_type from workplace_hint", () => {
    const job = buildJob({
      ...baseInput,
      workplace_hint: "Remote",
    });
    expect(job.workplace_type).toBe("remote");
  });

  it("falls back to location_text for workplace inference", () => {
    const job = buildJob({
      ...baseInput,
      location_text: "Remote, US",
    });
    expect(job.workplace_type).toBe("remote");
  });

  it("sets level and level_rank to null pre-classification", () => {
    const job = buildJob(baseInput);
    expect(job.level).toBeNull();
    expect(job.level_rank).toBeNull();
  });

  it("preserves compensation fields when provided", () => {
    const job = buildJob({
      ...baseInput,
      compensation_min: 18000000,
      compensation_max: 25000000,
      compensation_currency: "USD",
    });
    expect(job.compensation_min).toBe(18000000);
    expect(job.compensation_currency).toBe("USD");
  });

  it("trims title and company", () => {
    const job = buildJob({
      ...baseInput,
      title: "  Senior Software Engineer  ",
      company: "  Stripe  ",
    });
    expect(job.title).toBe("Senior Software Engineer");
    expect(job.company).toBe("Stripe");
  });

  it("flags is_recruiter_post when caller asserts", () => {
    const job = buildJob({ ...baseInput, is_recruiter_post: true });
    expect(job.is_recruiter_post).toBe(true);
  });

  it("preserves posted_at and updated_at when provided", () => {
    const job = buildJob({
      ...baseInput,
      posted_at: "2026-04-22T17:14:00Z",
      updated_at: "2026-04-25T09:03:00Z",
    });
    expect(job.posted_at).toBe("2026-04-22T17:14:00Z");
    expect(job.updated_at).toBe("2026-04-25T09:03:00Z");
  });

  it("includes department when provided", () => {
    const job = buildJob({ ...baseInput, department: "Engineering" });
    expect(job.department).toBe("Engineering");
  });
});
