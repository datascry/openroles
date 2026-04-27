import { describe, expect, it } from "bun:test";
import type { Tenant } from "@openroles/shared";
import { detectDeadTenants, type TenantSnapshot } from "./dead-tenants.ts";

function tenant(
  ats: Tenant["ats"],
  slug: string,
  status: Tenant["status"],
  observedAt = "2026-04-26T00:00:00Z",
): Tenant {
  return { ats, slug, status, last_probed_at: observedAt };
}

const T1 = "2026-03-01T00:00:00Z";
const T2 = "2026-03-15T00:00:00Z";
const T3 = "2026-04-01T00:00:00Z";
const T4 = "2026-04-15T00:00:00Z";

describe("detectDeadTenants", () => {
  it("returns [] when fewer history entries than the threshold exist", () => {
    const history: TenantSnapshot[] = [
      { observed_at: T1, tenants: [tenant("greenhouse", "stripe", "dead", T1)] },
    ];
    expect(detectDeadTenants(history, 3)).toEqual([]);
  });

  it("flags tenants dead in every snapshot of the trailing window", () => {
    const history: TenantSnapshot[] = [
      { observed_at: T1, tenants: [tenant("greenhouse", "alpha", "dead", T1)] },
      { observed_at: T2, tenants: [tenant("greenhouse", "alpha", "dead", T2)] },
      { observed_at: T3, tenants: [tenant("greenhouse", "alpha", "dead", T3)] },
    ];
    const alerts = detectDeadTenants(history, 3);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.slug).toBe("alpha");
    expect(alerts[0]?.consecutive_dead).toBe(3);
    expect(alerts[0]?.first_seen_dead_at).toBe(T1);
    expect(alerts[0]?.last_seen_dead_at).toBe(T3);
  });

  it("does not flag tenants that flickered to live in the window", () => {
    const history: TenantSnapshot[] = [
      { observed_at: T1, tenants: [tenant("greenhouse", "alpha", "dead", T1)] },
      { observed_at: T2, tenants: [tenant("greenhouse", "alpha", "live", T2)] },
      { observed_at: T3, tenants: [tenant("greenhouse", "alpha", "dead", T3)] },
    ];
    expect(detectDeadTenants(history, 3)).toEqual([]);
  });

  it("only considers the trailing window when more history is available", () => {
    const history: TenantSnapshot[] = [
      { observed_at: T1, tenants: [tenant("greenhouse", "alpha", "live", T1)] },
      { observed_at: T2, tenants: [tenant("greenhouse", "alpha", "dead", T2)] },
      { observed_at: T3, tenants: [tenant("greenhouse", "alpha", "dead", T3)] },
      { observed_at: T4, tenants: [tenant("greenhouse", "alpha", "dead", T4)] },
    ];
    const alerts = detectDeadTenants(history, 3);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.first_seen_dead_at).toBe(T2);
    expect(alerts[0]?.last_seen_dead_at).toBe(T4);
  });

  it("sorts alerts by canonical ATS_IDS order, not alphabetical", () => {
    // ATS_IDS canonical order is greenhouse, lever, ashby, bamboohr, workday, icims.
    // Alphabetical order would put 'ashby' before 'greenhouse', so this test
    // discriminates between the two.
    const history: TenantSnapshot[] = [
      {
        observed_at: T1,
        tenants: [tenant("ashby", "x", "dead", T1), tenant("greenhouse", "x", "dead", T1)],
      },
      {
        observed_at: T2,
        tenants: [tenant("ashby", "x", "dead", T2), tenant("greenhouse", "x", "dead", T2)],
      },
    ];
    const alerts = detectDeadTenants(history, 2);
    expect(alerts.map((a) => a.ats)).toEqual(["greenhouse", "ashby"]);
  });

  it("sorts alerts by ats then slug for deterministic output", () => {
    const history: TenantSnapshot[] = [
      {
        observed_at: T1,
        tenants: [
          tenant("lever", "zeta", "dead", T1),
          tenant("greenhouse", "beta", "dead", T1),
          tenant("greenhouse", "alpha", "dead", T1),
        ],
      },
      {
        observed_at: T2,
        tenants: [
          tenant("lever", "zeta", "dead", T2),
          tenant("greenhouse", "beta", "dead", T2),
          tenant("greenhouse", "alpha", "dead", T2),
        ],
      },
    ];
    const alerts = detectDeadTenants(history, 2);
    expect(alerts.map((a) => `${a.ats}/${a.slug}`)).toEqual([
      "greenhouse/alpha",
      "greenhouse/beta",
      "lever/zeta",
    ]);
  });

  it("handles unsorted input snapshots by sorting by observed_at", () => {
    const history: TenantSnapshot[] = [
      { observed_at: T2, tenants: [tenant("greenhouse", "alpha", "dead", T2)] },
      { observed_at: T1, tenants: [tenant("greenhouse", "alpha", "dead", T1)] },
    ];
    const alerts = detectDeadTenants(history, 2);
    expect(alerts[0]?.first_seen_dead_at).toBe(T1);
    expect(alerts[0]?.last_seen_dead_at).toBe(T2);
  });

  it("rejects threshold < 1", () => {
    expect(() => detectDeadTenants([], 0)).toThrow();
  });

  it("requires the tenant to be dead in the FIRST snapshot of the window (not appearing late)", () => {
    const history: TenantSnapshot[] = [
      { observed_at: T1, tenants: [] },
      { observed_at: T2, tenants: [tenant("greenhouse", "alpha", "dead", T2)] },
    ];
    expect(detectDeadTenants(history, 2)).toEqual([]);
  });

  it("returns [] when history is empty", () => {
    expect(detectDeadTenants([], 2)).toEqual([]);
  });
});
