import { describe, expect, it } from "bun:test";
import { filterRows, __test_internals as I, type SlimRow, sortRows } from "./slim-index.ts";

const ROW_BASE: SlimRow = {
  short_id: "0".repeat(16),
  ats: "greenhouse",
  tenant_slug: "stripe",
  title: "Engineer",
  company: "Stripe",
  level: "senior",
  workplace_type: "remote",
  is_recruiter_post: false,
  is_stale: false,
  location_text: "San Francisco, CA, US",
  location_country: "US",
  posted_at: "2026-04-25T00:00:00Z",
  first_seen_at: "2026-04-25T00:00:00Z",
  compensation_min: 150000,
  compensation_max: 200000,
  compensation_currency: "USD",
};

function row(over: Partial<SlimRow>): SlimRow {
  return { ...ROW_BASE, ...over };
}

describe("filterRows", () => {
  it("returns all rows when predicate is empty", () => {
    const rows = [row({ short_id: "a".repeat(16) }), row({ short_id: "b".repeat(16) })];
    const r = filterRows(rows, {}, 0, 10);
    expect(r.matches).toHaveLength(2);
    expect(r.total).toBe(2);
  });

  it("filters by ats set", () => {
    const rows = [
      row({ short_id: "a".repeat(16), ats: "greenhouse" }),
      row({ short_id: "b".repeat(16), ats: "lever" }),
      row({ short_id: "c".repeat(16), ats: "greenhouse" }),
    ];
    const r = filterRows(rows, { ats: new Set(["greenhouse"]) }, 0, 10);
    expect(r.matches).toHaveLength(2);
    expect(r.matches.every((m) => m.ats === "greenhouse")).toBe(true);
  });

  it("filters by level set, excluding rows with null level", () => {
    const rows = [
      row({ short_id: "a".repeat(16), level: "senior" }),
      row({ short_id: "b".repeat(16), level: null }),
      row({ short_id: "c".repeat(16), level: "junior" }),
    ];
    const r = filterRows(rows, { level: new Set(["senior", "staff"]) }, 0, 10);
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0]?.level).toBe("senior");
  });

  it("filters by workplace_type set", () => {
    const rows = [
      row({ short_id: "a".repeat(16), workplace_type: "remote" }),
      row({ short_id: "b".repeat(16), workplace_type: "onsite" }),
    ];
    const r = filterRows(rows, { workplace_type: new Set(["remote"]) }, 0, 10);
    expect(r.matches).toHaveLength(1);
  });

  it("filters by country (single value)", () => {
    const rows = [
      row({ short_id: "a".repeat(16), location_country: "US" }),
      row({ short_id: "b".repeat(16), location_country: "GB" }),
    ];
    const r = filterRows(rows, { country: "US" }, 0, 10);
    expect(r.matches).toHaveLength(1);
  });

  it("hideRecruiter excludes is_recruiter_post=true rows", () => {
    const rows = [
      row({ short_id: "a".repeat(16), is_recruiter_post: true }),
      row({ short_id: "b".repeat(16), is_recruiter_post: false }),
    ];
    const r = filterRows(rows, { hideRecruiter: true }, 0, 10);
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0]?.is_recruiter_post).toBe(false);
  });

  it("hideStale excludes is_stale=true rows", () => {
    const rows = [
      row({ short_id: "a".repeat(16), is_stale: true }),
      row({ short_id: "b".repeat(16), is_stale: false }),
    ];
    const r = filterRows(rows, { hideStale: true }, 0, 10);
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0]?.is_stale).toBe(false);
  });

  it("minComp excludes rows below the threshold and rows with null comp", () => {
    const rows = [
      row({ short_id: "a".repeat(16), compensation_min: 200000 }),
      row({ short_id: "b".repeat(16), compensation_min: 100000 }),
      row({ short_id: "c".repeat(16), compensation_min: null }),
    ];
    const r = filterRows(rows, { minComp: 150000 }, 0, 10);
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0]?.compensation_min).toBe(200000);
  });

  it("sinceMs excludes older rows and rows with null posted_at", () => {
    const cutoff = Date.parse("2026-04-20T00:00:00Z");
    const rows = [
      row({ short_id: "a".repeat(16), posted_at: "2026-04-25T00:00:00Z" }),
      row({ short_id: "b".repeat(16), posted_at: "2026-04-15T00:00:00Z" }),
      row({ short_id: "c".repeat(16), posted_at: null }),
    ];
    const r = filterRows(rows, { sinceMs: cutoff }, 0, 10);
    expect(r.matches).toHaveLength(1);
  });

  it("free-text q matches substring in title", () => {
    const rows = [
      row({ short_id: "a".repeat(16), title: "Senior Backend Engineer" }),
      row({ short_id: "b".repeat(16), title: "Frontend Designer" }),
    ];
    const r = filterRows(rows, { q: "engineer" }, 0, 10);
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0]?.title).toBe("Senior Backend Engineer");
  });

  it("free-text q matches substring in company too", () => {
    const rows = [
      row({ short_id: "a".repeat(16), title: "Engineer", company: "Stripe" }),
      row({ short_id: "b".repeat(16), title: "Engineer", company: "Linear" }),
    ];
    const r = filterRows(rows, { q: "stripe" }, 0, 10);
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0]?.company).toBe("Stripe");
  });

  it("free-text q matches substring in location_text", () => {
    const rows = [
      row({ short_id: "a".repeat(16), title: "Engineer", location_text: "Berlin, DE" }),
      row({ short_id: "b".repeat(16), title: "Engineer", location_text: "London, UK" }),
    ];
    const r = filterRows(rows, { q: "berlin" }, 0, 10);
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0]?.location_text).toBe("Berlin, DE");
  });

  it("free-text q matches substring in workplace_type ('remote' is the killer case)", () => {
    const rows = [
      row({ short_id: "a".repeat(16), title: "Engineer", workplace_type: "remote" }),
      row({ short_id: "b".repeat(16), title: "Engineer", workplace_type: "onsite" }),
    ];
    const r = filterRows(rows, { q: "remote" }, 0, 10);
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0]?.workplace_type).toBe("remote");
  });

  it("free-text q matches substring in level", () => {
    const rows = [
      row({ short_id: "a".repeat(16), title: "Engineer", level: "intern" }),
      row({ short_id: "b".repeat(16), title: "Engineer", level: "senior" }),
    ];
    const r = filterRows(rows, { q: "intern" }, 0, 10);
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0]?.level).toBe("intern");
  });

  it("idAllowlist gates the result set to specific short_ids", () => {
    const rows = [
      row({ short_id: "a".repeat(16) }),
      row({ short_id: "b".repeat(16) }),
      row({ short_id: "c".repeat(16) }),
    ];
    const allow = new Set([`${"a".repeat(16)}`, `${"c".repeat(16)}`]);
    const r = filterRows(rows, { idAllowlist: allow }, 0, 10);
    expect(r.matches).toHaveLength(2);
    expect(r.matches.map((m) => m.short_id)).toEqual(["a".repeat(16), "c".repeat(16)]);
  });

  it("multiple predicates AND together", () => {
    const rows = [
      row({ short_id: "a".repeat(16), ats: "greenhouse", level: "senior" }),
      row({ short_id: "b".repeat(16), ats: "lever", level: "senior" }),
      row({ short_id: "c".repeat(16), ats: "greenhouse", level: "junior" }),
    ];
    const r = filterRows(rows, { ats: new Set(["greenhouse"]), level: new Set(["senior"]) }, 0, 10);
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0]?.short_id).toBe("a".repeat(16));
  });

  it("respects offset + limit while keeping accurate total", () => {
    const rows = Array.from({ length: 20 }, (_, i) =>
      row({ short_id: i.toString(16).padStart(16, "0"), ats: "greenhouse" }),
    );
    const r = filterRows(rows, { ats: new Set(["greenhouse"]) }, 5, 7);
    expect(r.matches).toHaveLength(7);
    expect(r.total).toBe(20);
    // First match in `matches` is the 6th row in the input set
    expect(r.matches[0]?.short_id).toBe((5).toString(16).padStart(16, "0"));
  });

  it("regex special characters in q are escaped", () => {
    const rows = [
      row({ short_id: "a".repeat(16), title: "Engineer (Senior)" }),
      row({ short_id: "b".repeat(16), title: "Engineer Senior" }),
    ];
    const r = filterRows(rows, { q: "(Senior)" }, 0, 10);
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0]?.short_id).toBe("a".repeat(16));
  });

  it("free-text q is case-insensitive", () => {
    const rows = [row({ short_id: "a".repeat(16), title: "Senior Engineer" })];
    const r = filterRows(rows, { q: "SENIOR" }, 0, 10);
    expect(r.matches).toHaveLength(1);
  });
});

describe("__test_internals", () => {
  it("fromWire decodes the on-wire shape into SlimRow", () => {
    const decoded = I.fromWire({
      i: "0".repeat(16),
      a: "greenhouse",
      t: "stripe",
      ti: "Engineer",
      c: "Stripe",
      l: "senior",
      w: "remote",
      r: 1,
      s: 0,
      loc: "Remote",
      cc: "US",
      p: "2026-04-25T00:00:00Z",
      f: "2026-04-25T00:00:00Z",
      cm: 100000,
      cmax: 200000,
      cur: "USD",
    });
    expect(decoded.short_id).toBe("0".repeat(16));
    expect(decoded.is_recruiter_post).toBe(true);
    expect(decoded.is_stale).toBe(false);
    expect(decoded.compensation_min).toBe(100000);
  });

  it("appendUnique adds new rows and skips duplicates by short_id", () => {
    const target: SlimRow[] = [
      {
        short_id: "a".repeat(16),
        ats: "greenhouse",
        tenant_slug: "x",
        title: "T",
        company: "C",
        level: null,
        workplace_type: null,
        is_recruiter_post: false,
        is_stale: false,
        location_text: null,
        location_country: null,
        posted_at: null,
        first_seen_at: "2026-04-25T00:00:00Z",
        compensation_min: null,
        compensation_max: null,
        compensation_currency: null,
      },
    ];
    const seed = target[0];
    if (!seed) throw new Error("test fixture broken");
    I.appendUnique(target, [
      // Same short_id as the existing row — should be skipped.
      { ...seed },
      { ...seed, short_id: "b".repeat(16) },
    ]);
    expect(target).toHaveLength(2);
    expect(target.map((r) => r.short_id)).toEqual(["a".repeat(16), "b".repeat(16)]);
  });

  it("appendUnique fast-paths when target is empty", () => {
    const target: SlimRow[] = [];
    const incoming: SlimRow[] = [
      {
        short_id: "a".repeat(16),
        ats: "greenhouse",
        tenant_slug: "x",
        title: "T",
        company: "C",
        level: null,
        workplace_type: null,
        is_recruiter_post: false,
        is_stale: false,
        location_text: null,
        location_country: null,
        posted_at: null,
        first_seen_at: "2026-04-25T00:00:00Z",
        compensation_min: null,
        compensation_max: null,
        compensation_currency: null,
      },
    ];
    I.appendUnique(target, incoming);
    expect(target).toHaveLength(1);
  });
});

describe("sortRows", () => {
  it("posted_at:desc — null posted_at sorts to the end", () => {
    const rows = [
      row({ short_id: "a".repeat(16), posted_at: "2026-04-20T00:00:00Z" }),
      row({ short_id: "b".repeat(16), posted_at: null }),
      row({ short_id: "c".repeat(16), posted_at: "2026-04-25T00:00:00Z" }),
    ];
    sortRows(rows, "posted_at:desc");
    expect(rows.map((r) => r.short_id)).toEqual(["c".repeat(16), "a".repeat(16), "b".repeat(16)]);
  });

  it("posted_at:asc — null posted_at sorts to the end too (NULLS LAST in both directions)", () => {
    const rows = [
      row({ short_id: "a".repeat(16), posted_at: "2026-04-25T00:00:00Z" }),
      row({ short_id: "b".repeat(16), posted_at: null }),
      row({ short_id: "c".repeat(16), posted_at: "2026-04-20T00:00:00Z" }),
    ];
    sortRows(rows, "posted_at:asc");
    expect(rows.map((r) => r.short_id)).toEqual(["c".repeat(16), "a".repeat(16), "b".repeat(16)]);
  });

  it("first_seen:desc orders newest first", () => {
    const rows = [
      row({ short_id: "a".repeat(16), first_seen_at: "2026-04-20T00:00:00Z" }),
      row({ short_id: "b".repeat(16), first_seen_at: "2026-04-25T00:00:00Z" }),
    ];
    sortRows(rows, "first_seen:desc");
    expect(rows[0]?.short_id).toBe("b".repeat(16));
  });

  it("first_seen:asc orders oldest first", () => {
    const rows = [
      row({ short_id: "a".repeat(16), first_seen_at: "2026-04-25T00:00:00Z" }),
      row({ short_id: "b".repeat(16), first_seen_at: "2026-04-20T00:00:00Z" }),
    ];
    sortRows(rows, "first_seen:asc");
    expect(rows[0]?.short_id).toBe("b".repeat(16));
  });

  it("level:asc orders junior → senior, nulls last", () => {
    const rows = [
      row({ short_id: "a".repeat(16), level: "senior" }),
      row({ short_id: "b".repeat(16), level: "junior" }),
      row({ short_id: "c".repeat(16), level: null }),
      row({ short_id: "d".repeat(16), level: "staff" }),
    ];
    sortRows(rows, "level:asc");
    expect(rows.map((r) => r.level)).toEqual(["junior", "senior", "staff", null]);
  });

  it("level:desc orders senior → junior, nulls still last", () => {
    const rows = [
      row({ short_id: "a".repeat(16), level: "senior" }),
      row({ short_id: "b".repeat(16), level: "junior" }),
      row({ short_id: "c".repeat(16), level: null }),
      row({ short_id: "d".repeat(16), level: "staff" }),
    ];
    sortRows(rows, "level:desc");
    expect(rows.map((r) => r.level)).toEqual(["staff", "senior", "junior", null]);
  });

  it("level sort tiebreaks by posted_at DESC", () => {
    const rows = [
      row({
        short_id: "a".repeat(16),
        level: "senior",
        posted_at: "2026-04-20T00:00:00Z",
      }),
      row({
        short_id: "b".repeat(16),
        level: "senior",
        posted_at: "2026-04-25T00:00:00Z",
      }),
    ];
    sortRows(rows, "level:asc");
    expect(rows[0]?.short_id).toBe("b".repeat(16));
  });

  it("company:asc / company:desc are case-insensitive", () => {
    const rows = [
      row({ short_id: "a".repeat(16), company: "Stripe" }),
      row({ short_id: "b".repeat(16), company: "anthropic" }),
      row({ short_id: "c".repeat(16), company: "Linear" }),
    ];
    sortRows(rows, "company:asc");
    expect(rows.map((r) => r.company)).toEqual(["anthropic", "Linear", "Stripe"]);
    sortRows(rows, "company:desc");
    expect(rows.map((r) => r.company)).toEqual(["Stripe", "Linear", "anthropic"]);
  });

  it("posted_at:desc tiebreaks by first_seen_at DESC", () => {
    const rows = [
      row({
        short_id: "a".repeat(16),
        posted_at: "2026-04-25T00:00:00Z",
        first_seen_at: "2026-04-20T00:00:00Z",
      }),
      row({
        short_id: "b".repeat(16),
        posted_at: "2026-04-25T00:00:00Z",
        first_seen_at: "2026-04-25T00:00:00Z",
      }),
    ];
    sortRows(rows, "posted_at:desc");
    expect(rows[0]?.short_id).toBe("b".repeat(16));
  });
});
