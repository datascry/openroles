import { describe, expect, it } from "bun:test";
import { TenantSchema } from "./tenant.ts";

describe("TenantSchema", () => {
  it("accepts a minimal tenant", () => {
    const t = TenantSchema.parse({
      ats: "greenhouse",
      slug: "stripe",
      status: "live",
      last_probed_at: "2026-04-26T00:00:00Z",
    });
    expect(t.slug).toBe("stripe");
  });

  it("accepts a tenant with display_name and homepage_url", () => {
    const t = TenantSchema.parse({
      ats: "lever",
      slug: "anthropic",
      display_name: "Anthropic",
      homepage_url: "https://www.anthropic.com",
      status: "live",
      last_probed_at: "2026-04-26T00:00:00Z",
    });
    expect(t.display_name).toBe("Anthropic");
  });

  it("rejects unknown status", () => {
    expect(() =>
      TenantSchema.parse({
        ats: "greenhouse",
        slug: "stripe",
        status: "alive",
        last_probed_at: "2026-04-26T00:00:00Z",
      }),
    ).toThrow();
  });

  it("rejects malformed slug", () => {
    expect(() =>
      TenantSchema.parse({
        ats: "greenhouse",
        slug: "Stripe!",
        status: "live",
        last_probed_at: "2026-04-26T00:00:00Z",
      }),
    ).toThrow();
  });

  it("rejects bare-string homepage_url", () => {
    expect(() =>
      TenantSchema.parse({
        ats: "greenhouse",
        slug: "stripe",
        status: "live",
        last_probed_at: "2026-04-26T00:00:00Z",
        homepage_url: "not-a-url",
      }),
    ).toThrow();
  });

  it("rejects non-http(s) URL schemes (javascript:, data:, file:)", () => {
    for (const u of ["javascript:alert(1)", "data:text/html,<x>", "file:///etc/passwd"]) {
      expect(() =>
        TenantSchema.parse({
          ats: "greenhouse",
          slug: "stripe",
          status: "live",
          last_probed_at: "2026-04-26T00:00:00Z",
          homepage_url: u,
        }),
      ).toThrow();
    }
  });
});
