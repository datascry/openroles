import { describe, expect, it } from "bun:test";
import { ScrapeInputSchema, ScrapeOutputSchema, TenantResultSchema } from "./scrape.ts";

describe("TenantResultSchema", () => {
  it("accepts success with http_status and jobs_count", () => {
    const r = TenantResultSchema.parse({
      slug: "stripe",
      status: "success",
      http_status: 200,
      jobs_count: 42,
    });
    expect(r.status).toBe("success");
  });

  it("accepts dead with error message", () => {
    const r = TenantResultSchema.parse({
      slug: "stripe",
      status: "dead",
      http_status: 404,
      error: "tenant not found",
      jobs_count: 0,
    });
    expect(r.status).toBe("dead");
  });

  it("rejects negative jobs_count", () => {
    expect(() =>
      TenantResultSchema.parse({
        slug: "stripe",
        status: "success",
        jobs_count: -1,
      }),
    ).toThrow();
  });
});

describe("ScrapeInputSchema", () => {
  it("accepts a minimal input", () => {
    const i = ScrapeInputSchema.parse({
      ats: "greenhouse",
      tenants: [{ slug: "stripe" }],
      userAgent: "openroles/0.0.0 (+https://example.com/contact)",
      contactUrl: "https://example.com/contact",
    });
    expect(i.tenants).toHaveLength(1);
  });

  it("rejects empty userAgent", () => {
    expect(() =>
      ScrapeInputSchema.parse({
        ats: "greenhouse",
        tenants: [],
        userAgent: "",
        contactUrl: "https://example.com",
      }),
    ).toThrow();
  });

  it("rejects tenant with bad slug", () => {
    expect(() =>
      ScrapeInputSchema.parse({
        ats: "greenhouse",
        tenants: [{ slug: "Stripe!" }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      }),
    ).toThrow();
  });

  it("rejects retry maxAttempts of zero", () => {
    expect(() =>
      ScrapeInputSchema.parse({
        ats: "greenhouse",
        tenants: [],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
        retry: { maxAttempts: 0, baseMs: 500, maxMs: 30000 },
      }),
    ).toThrow();
  });
});

describe("ScrapeOutputSchema", () => {
  it("accepts an empty output", () => {
    const o = ScrapeOutputSchema.parse({
      ats: "greenhouse",
      jobs: [],
      tenant_results: [],
      metrics: {
        started_at: "2026-04-26T00:00:00Z",
        finished_at: "2026-04-26T00:00:01Z",
        duration_ms: 1000,
        requests_made: 0,
        requests_failed: 0,
        requests_retried: 0,
        bytes_received: 0,
      },
    });
    expect(o.jobs).toEqual([]);
  });
});
