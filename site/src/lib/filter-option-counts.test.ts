import { describe, expect, it } from "bun:test";
import {
  buildOptionCountsQuery,
  type CountedDimension,
  computeSlimOptionCounts,
} from "./filter-option-counts.ts";
import { DEFAULT_FILTER_STATE, type FilterState } from "./filter-state.ts";
import type { FilterPredicate, SlimRow } from "./slim-index.ts";

const baseState: FilterState = { ...DEFAULT_FILTER_STATE };

function pickColumn(dim: CountedDimension): string {
  return dim === "ats" ? "ats" : dim === "level" ? "level" : "workplace_type";
}

describe("buildOptionCountsQuery", () => {
  it.each([
    "ats",
    "level",
    "wt",
  ] as const)("emits a SELECT col, COUNT(*) ... GROUP BY col for dimension %s", (dim) => {
    const plan = buildOptionCountsQuery(dim, baseState);
    const col = pickColumn(dim);
    expect(plan.sql).toContain(`SELECT ${col} AS v, COUNT(*) AS c`);
    expect(plan.sql).toContain(`GROUP BY ${col}`);
    expect(plan.sql).toContain("FROM jobs");
  });

  it("excludes NULL values from the chip-grouped result", () => {
    const plan = buildOptionCountsQuery("level", baseState);
    expect(plan.sql).toMatch(/level IS NOT NULL/);
  });

  it("clears the named dimension before applying other filters (ats)", () => {
    const stateWithAts: FilterState = {
      ...baseState,
      ats: ["greenhouse", "lever"],
      level: ["senior"],
    };
    const plan = buildOptionCountsQuery("ats", stateWithAts);
    // The `ats IN (?, ?)` clause must NOT appear (we cleared ats).
    expect(plan.sql).not.toMatch(/ats IN \(/);
    // The level filter MUST still appear.
    expect(plan.sql).toMatch(/level IN \(\?\)/);
    // Params: only the level value(s).
    expect(plan.params).toContain("senior");
    expect(plan.params).not.toContain("greenhouse");
  });

  it("clears the named dimension before applying other filters (level)", () => {
    const stateWithLevel: FilterState = {
      ...baseState,
      level: ["senior", "staff"],
      ats: ["greenhouse"],
    };
    const plan = buildOptionCountsQuery("level", stateWithLevel);
    expect(plan.sql).not.toMatch(/level IN \(/);
    expect(plan.sql).toMatch(/ats IN \(\?\)/);
    expect(plan.params).toContain("greenhouse");
  });

  it("clears the named dimension before applying other filters (wt)", () => {
    const stateWithWt: FilterState = {
      ...baseState,
      wt: ["remote", "hybrid"],
      ats: ["greenhouse"],
    };
    const plan = buildOptionCountsQuery("wt", stateWithWt);
    expect(plan.sql).not.toMatch(/workplace_type IN \(/);
    expect(plan.sql).toMatch(/ats IN \(\?\)/);
  });

  it("preserves search query, since, hideRecruiter, hideStale, minComp predicates", () => {
    const state: FilterState = {
      ...baseState,
      q: "engineer",
      since: "7d",
      hideRecruiter: true,
      hideStale: true,
      minComp: 100_000,
    };
    const plan = buildOptionCountsQuery("ats", state);
    expect(plan.sql).toMatch(/jobs_fts MATCH/);
    expect(plan.sql).toMatch(/posted_at >= datetime/);
    expect(plan.sql).toMatch(/is_recruiter_post = 0/);
    expect(plan.sql).toMatch(/is_stale = 0/);
    expect(plan.sql).toMatch(/compensation_min/);
  });

  it("respects an idAllowlist option", () => {
    const ids = ["a".repeat(64), "b".repeat(64)];
    const plan = buildOptionCountsQuery("ats", baseState, { idAllowlist: ids });
    expect(plan.sql).toMatch(/id IN \(\?,\?\)/);
    expect(plan.params).toContain(ids[0]);
    expect(plan.params).toContain(ids[1]);
  });
});

// ---------------------------------------------------------------------------
// computeSlimOptionCounts — in-memory equivalent for the slim-index runtime.
// The chip counts power the desktop sidebar / mobile sheet (specs/uplift-v2-
// handoff.md §2.5/§2.7.b) and must mirror the SQL plan's intent: clear the
// chip's own dimension before counting so toggling shows the true reach.
// ---------------------------------------------------------------------------

function makeRow(overrides: Partial<SlimRow> = {}): SlimRow {
  return {
    short_id: "0123456789abcdef",
    ats: "greenhouse",
    tenant_slug: "stripe",
    title: "Senior Engineer",
    company: "Stripe",
    level: "senior",
    workplace_type: "remote",
    is_recruiter_post: false,
    is_stale: false,
    location_text: null,
    location_country: null,
    posted_at: null,
    first_seen_at: "2026-04-26T00:00:00Z",
    compensation_min: null,
    compensation_max: null,
    compensation_currency: null,
    ...overrides,
  };
}

function buildPredicateForTest(s: FilterState): FilterPredicate {
  // Mirror the FilterTable runtime predicate (subset relevant to these
  // tests). Real component test coverage lives in Playwright e2e.
  const p: FilterPredicate = {};
  if (s.q.trim().length > 0) p.q = s.q.trim();
  if (s.ats.length > 0) p.ats = new Set(s.ats);
  if (s.level.length > 0) p.level = new Set(s.level);
  if (s.wt.length > 0) p.workplace_type = new Set(s.wt);
  if (s.hideRecruiter) p.hideRecruiter = true;
  if (s.hideStale) p.hideStale = true;
  if (s.minComp !== undefined) p.minComp = s.minComp;
  return p;
}

const UNFILTERED_STATE: FilterState = { ...DEFAULT_FILTER_STATE, since: "all" };

describe("computeSlimOptionCounts", () => {
  it("returns per-value counts for ats / level / wt", () => {
    const rows: SlimRow[] = [
      makeRow({
        short_id: "a".repeat(16),
        ats: "greenhouse",
        level: "senior",
        workplace_type: "remote",
      }),
      makeRow({ short_id: "b".repeat(16), ats: "lever", level: "staff", workplace_type: "remote" }),
      makeRow({ short_id: "c".repeat(16), ats: "lever", level: "staff", workplace_type: "hybrid" }),
    ];
    const counts = computeSlimOptionCounts(rows, UNFILTERED_STATE, buildPredicateForTest);
    expect(counts.ats).toEqual({ greenhouse: 1, lever: 2 });
    expect(counts.level).toEqual({ senior: 1, staff: 2 });
    expect(counts.wt).toEqual({ remote: 2, hybrid: 1 });
  });

  it("clears the named dim before applying other filters (ats counts ignore ats selection)", () => {
    const rows: SlimRow[] = [
      makeRow({ short_id: "a".repeat(16), ats: "greenhouse", level: "senior" }),
      makeRow({ short_id: "b".repeat(16), ats: "lever", level: "senior" }),
      makeRow({ short_id: "c".repeat(16), ats: "ashby", level: "junior" }),
    ];
    const stateWithSel: FilterState = {
      ...UNFILTERED_STATE,
      ats: ["greenhouse"], // user has selected greenhouse only
      level: ["senior"], // and senior
    };
    const counts = computeSlimOptionCounts(rows, stateWithSel, buildPredicateForTest);
    // ats count should reflect the level=senior filter but NOT the ats=greenhouse one.
    expect(counts.ats).toEqual({ greenhouse: 1, lever: 1 });
    // level count should reflect ats=greenhouse but NOT level=senior.
    expect(counts.level).toEqual({ senior: 1 });
  });

  it("excludes null dimension values from the count buckets", () => {
    const rows: SlimRow[] = [
      makeRow({ short_id: "a".repeat(16), level: null, workplace_type: null }),
      makeRow({ short_id: "b".repeat(16), level: "mid", workplace_type: "remote" }),
    ];
    const counts = computeSlimOptionCounts(rows, UNFILTERED_STATE, buildPredicateForTest);
    expect(counts.level).toEqual({ mid: 1 });
    expect(counts.wt).toEqual({ remote: 1 });
  });

  it("returns empty maps when no rows match the cleared-dim predicate", () => {
    const rows: SlimRow[] = [makeRow({ short_id: "a".repeat(16) })];
    const stateWithText: FilterState = { ...UNFILTERED_STATE, q: "nomatch" };
    const counts = computeSlimOptionCounts(rows, stateWithText, buildPredicateForTest);
    expect(counts.ats).toEqual({});
    expect(counts.level).toEqual({});
    expect(counts.wt).toEqual({});
  });
});
