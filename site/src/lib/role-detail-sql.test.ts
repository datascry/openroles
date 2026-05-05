import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import * as fc from "fast-check";
import {
  FTS_OPTIMIZE_STMT,
  INDEX_DDL,
  PAGE_SIZE_PRAGMA,
  SCHEMA_DDL,
} from "../../../scraper/src/db/schema.ts";
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
  it("emits an index-eligible substr() equality (matches idx_jobs_short_id)", () => {
    const plan = buildRoleByShortIdQuery("abcdef0123456789");
    expect(plan.sql).toContain("FROM jobs");
    // The WHERE clause must match the indexed expression VERBATIM
    // (CREATE INDEX … ON jobs(substr(id, 1, 16))) for SQLite's planner
    // to pick the index. A BETWEEN range over the PRIMARY KEY would
    // also be index-eligible but scans 50% of the key space; this is
    // a single index lookup.
    expect(plan.sql).toContain("WHERE substr(id, 1, 16) = ?");
    expect(plan.sql).toContain("LIMIT 1");
    expect(plan.params).toEqual(["abcdef0123456789"]);
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
    it("emits a single placeholder bound to the verbatim short id", () => {
      fc.assert(
        fc.property(fc.stringMatching(/^[0-9a-f]{16}$/), (id: string) => {
          const plan = buildRoleByShortIdQuery(id);
          expect(plan.sql.match(/\?/g)).toHaveLength(1);
          expect(plan.params).toEqual([id]);
        }),
      );
    });
  });
});

describe("buildRoleByShortIdQuery — index-binding integration", () => {
  function makeDb(): Database {
    const db = new Database(":memory:");
    db.exec(PAGE_SIZE_PRAGMA);
    db.exec(SCHEMA_DDL);
    db.exec(INDEX_DDL);
    db.exec(FTS_OPTIMIZE_STMT);
    return db;
  }

  it("EXPLAIN QUERY PLAN binds the SELECT to idx_jobs_short_id", () => {
    const db = makeDb();
    try {
      const plan = buildRoleByShortIdQuery("abcdef0123456789");
      const explain = db.query(`EXPLAIN QUERY PLAN ${plan.sql}`).all(...plan.params) as Array<{
        detail: string;
      }>;
      const detail = explain.map((r) => r.detail).join(" | ");
      // Without the expression index, SQLite either scans the whole jobs
      // table or uses the PRIMARY KEY but not in a way that mentions
      // idx_jobs_short_id. Asserting the index name keeps us honest if
      // the WHERE clause ever drifts away from the indexed expression.
      expect(detail).toContain("idx_jobs_short_id");
    } finally {
      db.close();
    }
  });

  it("returns the inserted row when queried by its 16-char prefix", () => {
    const db = makeDb();
    try {
      const fullId = "f".repeat(64);
      db.run(
        "INSERT INTO jobs (id, ats, tenant_slug, source_id, title, company, first_seen_at, last_seen_at, url) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
          fullId,
          "greenhouse",
          "stripe",
          "stripe-1",
          "Senior Engineer",
          "Stripe",
          "2026-04-26T00:00:00Z",
          "2026-04-26T00:00:00Z",
          "https://example.com/1",
        ],
      );
      const plan = buildRoleByShortIdQuery(fullId.slice(0, 16));
      const rows = db.query(plan.sql).all(...plan.params) as Array<{ id: string }>;
      expect(rows.map((r) => r.id)).toEqual([fullId]);
    } finally {
      db.close();
    }
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
