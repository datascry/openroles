import { describe, expect, it } from "bun:test";
import fc from "fast-check";
import { jobId } from "./job-id.ts";

describe("jobId", () => {
  it("produces a 64-char hex SHA-256", () => {
    const id = jobId({
      ats: "greenhouse",
      tenant_slug: "stripe",
      source_id: "5839271",
      url: "https://boards.greenhouse.io/stripe/jobs/5839271",
    });
    expect(id).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic for identical inputs", () => {
    const args = {
      ats: "lever" as const,
      tenant_slug: "anthropic",
      source_id: "abc",
      url: "https://jobs.lever.co/anthropic/abc",
    };
    expect(jobId(args)).toBe(jobId(args));
  });

  it("changes when any field changes", () => {
    const base = {
      ats: "greenhouse" as const,
      tenant_slug: "stripe",
      source_id: "1",
      url: "https://example.com/1",
    };
    const a = jobId(base);
    expect(jobId({ ...base, ats: "lever" })).not.toBe(a);
    expect(jobId({ ...base, tenant_slug: "anthropic" })).not.toBe(a);
    expect(jobId({ ...base, source_id: "2" })).not.toBe(a);
    expect(jobId({ ...base, url: "https://example.com/2" })).not.toBe(a);
  });

  it("does not collide on field-boundary tricks", () => {
    const a = jobId({
      ats: "greenhouse",
      tenant_slug: "stripe",
      source_id: "abc",
      url: "https://x/y",
    });
    const b = jobId({
      ats: "greenhouse",
      tenant_slug: "stripeabc",
      source_id: "",
      url: "https://x/y",
    });
    expect(a).not.toBe(b);
  });

  it("is deterministic property", () => {
    fc.assert(
      fc.property(
        fc.record({
          ats: fc.constantFrom(
            "greenhouse" as const,
            "lever" as const,
            "ashby" as const,
            "bamboohr" as const,
            "workday" as const,
            "icims" as const,
          ),
          tenant_slug: fc.string({ minLength: 1, maxLength: 32 }),
          source_id: fc.string({ minLength: 1, maxLength: 32 }),
          url: fc.webUrl(),
        }),
        (input) => {
          const first = jobId(input);
          const second = jobId(input);
          return first === second;
        },
      ),
    );
  });
});
