import { describe, expect, it } from "bun:test";
import { buildRelatedRolesCountQuery, buildRelatedRolesQuery } from "./role-related-sql.ts";

const TENANT = "stripe";
const FULL_ID = "a".repeat(64);

describe("buildRelatedRolesQuery", () => {
  it("emits a SELECT with tenant_slug + id != ? + is_stale = 0 + ORDER BY + LIMIT", () => {
    const plan = buildRelatedRolesQuery(TENANT, FULL_ID, 4);
    expect(plan.sql).toContain("tenant_slug = ?");
    expect(plan.sql).toContain("id != ?");
    expect(plan.sql).toContain("is_stale = 0");
    expect(plan.sql).toContain("ORDER BY");
    expect(plan.sql).toContain("LIMIT ?");
    expect(plan.params).toEqual([TENANT, FULL_ID, 4]);
  });

  it("uses default limit 4 when omitted", () => {
    const plan = buildRelatedRolesQuery(TENANT, FULL_ID);
    expect(plan.params[2]).toBe(4);
  });

  it("orders posted_at DESC with NULLs last, then first_seen_at DESC", () => {
    const plan = buildRelatedRolesQuery(TENANT, FULL_ID);
    expect(plan.sql).toMatch(/posted_at IS NULL ASC.*posted_at DESC.*first_seen_at DESC/s);
  });

  it("rejects an invalid tenant_slug", () => {
    expect(() => buildRelatedRolesQuery("Stripe!", FULL_ID)).toThrow(/tenant_slug/);
    expect(() => buildRelatedRolesQuery("", FULL_ID)).toThrow(/tenant_slug/);
  });

  it("rejects a short / non-hex excludeId", () => {
    expect(() => buildRelatedRolesQuery(TENANT, "abc")).toThrow(/excludeId/);
    expect(() => buildRelatedRolesQuery(TENANT, "Z".repeat(64))).toThrow(/excludeId/);
  });

  it("rejects out-of-range limit", () => {
    expect(() => buildRelatedRolesQuery(TENANT, FULL_ID, 0)).toThrow(/limit/);
    expect(() => buildRelatedRolesQuery(TENANT, FULL_ID, 51)).toThrow(/limit/);
    expect(() => buildRelatedRolesQuery(TENANT, FULL_ID, 1.5)).toThrow(/limit/);
  });
});

describe("buildRelatedRolesCountQuery", () => {
  it("emits a SELECT COUNT with the same predicates", () => {
    const plan = buildRelatedRolesCountQuery(TENANT, FULL_ID);
    expect(plan.sql).toMatch(/SELECT COUNT\(\*\)/);
    expect(plan.sql).toContain("tenant_slug = ?");
    expect(plan.sql).toContain("id != ?");
    expect(plan.sql).toContain("is_stale = 0");
    expect(plan.params).toEqual([TENANT, FULL_ID]);
  });

  it("rejects invalid args", () => {
    expect(() => buildRelatedRolesCountQuery("BAD!", FULL_ID)).toThrow(/tenant_slug/);
    expect(() => buildRelatedRolesCountQuery(TENANT, "abc")).toThrow(/excludeId/);
  });
});
