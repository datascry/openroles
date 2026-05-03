import { describe, expect, it } from "bun:test";
import * as fc from "fast-check";
import { buildRoleByShortIdQuery, isShortId, shortIdFromJobId } from "./role-detail-sql.ts";

describe("isShortId", () => {
  it("accepts a 16-char lowercase hex string", () => {
    expect(isShortId("0123456789abcdef")).toBe(true);
  });

  it("rejects strings of the wrong length", () => {
    expect(isShortId("0123456789abcde")).toBe(false); // 15
    expect(isShortId("0123456789abcdef0")).toBe(false); // 17
    expect(isShortId("")).toBe(false);
  });

  it("rejects non-hex characters", () => {
    expect(isShortId("0123456789abcdeg")).toBe(false);
    expect(isShortId("0123456789ABCDEF")).toBe(false);
  });

  it("rejects non-string inputs", () => {
    expect(isShortId(undefined)).toBe(false);
    expect(isShortId(null)).toBe(false);
  });
});

describe("buildRoleByShortIdQuery", () => {
  it("emits a SELECT bound to the 16-char prefix via an index-friendly BETWEEN", () => {
    const plan = buildRoleByShortIdQuery("abcdef0123456789");
    expect(plan.sql).toContain("FROM jobs");
    // BETWEEN keeps the predicate index-eligible — wrapping `id` in
    // substr() forces a full table scan.
    expect(plan.sql).toContain("WHERE id BETWEEN ? AND ?");
    expect(plan.sql).toContain("LIMIT 1");
    expect(plan.params).toEqual([
      `abcdef0123456789${"0".repeat(48)}`,
      `abcdef0123456789${"f".repeat(48)}`,
    ]);
  });

  it("includes every column the role page reads", () => {
    const plan = buildRoleByShortIdQuery("abcdef0123456789");
    for (const col of [
      "id",
      "ats",
      "tenant_slug",
      "source_id",
      "title",
      "company",
      "description_excerpt",
      "level",
      "level_rank",
      "workplace_type",
      "is_recruiter_post",
      "location_text",
      "location_country",
      "location_region",
      "compensation_min",
      "compensation_max",
      "compensation_currency",
      "department",
      "posted_at",
      "updated_at",
      "first_seen_at",
      "last_seen_at",
      "is_stale",
      "url",
    ]) {
      expect(plan.sql).toContain(col);
    }
  });

  it("throws on an invalid short id", () => {
    expect(() => buildRoleByShortIdQuery("not-hex")).toThrow();
    expect(() => buildRoleByShortIdQuery("0123456789ABCDEF")).toThrow();
  });

  describe("invariants", () => {
    it("emits two placeholders bound to the [shortId+0…0, shortId+f…f] range", () => {
      fc.assert(
        fc.property(fc.stringMatching(/^[0-9a-f]{16}$/), (id: string) => {
          const plan = buildRoleByShortIdQuery(id);
          expect(plan.sql.match(/\?/g)).toHaveLength(2);
          expect(plan.params).toHaveLength(2);
          expect(plan.params[0]).toBe(id + "0".repeat(48));
          expect(plan.params[1]).toBe(id + "f".repeat(48));
          // The range matches exactly the ids whose first 16 chars equal id.
          const lo = String(plan.params[0]);
          const hi = String(plan.params[1]);
          expect(lo.startsWith(id)).toBe(true);
          expect(hi.startsWith(id)).toBe(true);
          expect(lo.length).toBe(64);
          expect(hi.length).toBe(64);
        }),
      );
    });
  });
});

describe("shortIdFromJobId", () => {
  it("returns the first 16 chars of a 64-char hex id", () => {
    const full = "0123456789abcdef".repeat(4);
    expect(shortIdFromJobId(full)).toBe("0123456789abcdef");
    expect(shortIdFromJobId(full)).toHaveLength(16);
  });

  it("is the inverse contract: the short id is a prefix of the full id", () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[0-9a-f]{64}$/), (full: string) => {
        const short = shortIdFromJobId(full);
        expect(full.startsWith(short)).toBe(true);
        expect(short).toHaveLength(16);
      }),
    );
  });
});
