import { describe, expect, it } from "bun:test";
import { ATS_IDS, LEVELS, WORKPLACE_TYPES } from "@openroles/shared";
import fc from "fast-check";
import {
  DEFAULT_FILTER_STATE,
  decodeFilterState,
  encodeFilterState,
  type FilterState,
  sameFilterState,
} from "./filter-state.ts";

describe("encode + decodeFilterState", () => {
  it("round-trips the default state to an empty query string", () => {
    expect(encodeFilterState(DEFAULT_FILTER_STATE)).toBe("");
  });

  it("encodes the canonical example URL from the spec", () => {
    const url = encodeFilterState({
      q: "engineer",
      ats: ["greenhouse", "lever"],
      level: ["senior", "staff"],
      wt: ["remote"],
      country: undefined,
      region: undefined,
      since: "7d",
      hideRecruiter: true,
      hideStale: false,
      showOnly: undefined,
      minComp: undefined,
      sort: "posted_at:desc",
      page: 1,
    });
    const params = new URLSearchParams(url);
    expect(params.get("q")).toBe("engineer");
    expect(params.get("ats")).toBe("greenhouse,lever");
    expect(params.get("level")).toBe("senior,staff");
    expect(params.get("wt")).toBe("remote");
    expect(params.get("since")).toBe("7d");
    expect(params.get("recruiter")).toBe("0");
    expect(params.get("page")).toBeNull();
  });

  it("omits empty / default values", () => {
    const url = encodeFilterState({
      ...DEFAULT_FILTER_STATE,
      q: "x",
    });
    expect(url).toBe("q=x");
  });

  it("ignores unknown params on decode (forward-compatible)", () => {
    const s = decodeFilterState("q=x&futureFlag=1");
    expect(s.q).toBe("x");
  });

  it("falls back to default sort on unknown sort value", () => {
    const s = decodeFilterState("sort=lol");
    expect(s.sort).toBe(DEFAULT_FILTER_STATE.sort);
  });

  it("clamps min_comp below 0 to undefined and above 1e9 to 1e9", () => {
    expect(decodeFilterState("min_comp=-5").minComp).toBeUndefined();
    expect(decodeFilterState("min_comp=10000000000").minComp).toBe(1_000_000_000);
  });

  it("treats q with only FTS5 operator characters as empty", () => {
    expect(decodeFilterState("q=%22%22").q).toBe("");
    expect(decodeFilterState("q=AND%20OR%20NEAR").q).toBe("");
  });

  it("truncates q longer than 256 chars", () => {
    const long = "x".repeat(500);
    const s = decodeFilterState(`q=${long}`);
    expect(s.q.length).toBe(256);
  });

  it("clamps page below 1 to 1", () => {
    expect(decodeFilterState("page=0").page).toBe(1);
    expect(decodeFilterState("page=-7").page).toBe(1);
  });

  it("filters out unknown ats / level / wt values silently", () => {
    const s = decodeFilterState("ats=greenhouse,evil&level=senior,architect&wt=remote,space");
    expect(s.ats).toEqual(["greenhouse"]);
    expect(s.level).toEqual(["senior"]);
    expect(s.wt).toEqual(["remote"]);
  });

  it("rejects malformed country and region", () => {
    expect(decodeFilterState("country=USA").country).toBeUndefined();
    expect(decodeFilterState("country=US&region=California").region).toBe("California");
  });

  it("uppercases lowercase country before validating", () => {
    expect(decodeFilterState("country=us").country).toBe("US");
    expect(decodeFilterState("country=Gb").country).toBe("GB");
  });

  it("treats recruiter values other than '0' as 'show'", () => {
    expect(decodeFilterState("recruiter=1").hideRecruiter).toBe(false);
    expect(decodeFilterState("recruiter=true").hideRecruiter).toBe(false);
    expect(decodeFilterState("recruiter=0").hideRecruiter).toBe(true);
  });

  it("treats hide_stale=1 as the only enabling value", () => {
    expect(decodeFilterState("hide_stale=1").hideStale).toBe(true);
    expect(decodeFilterState("hide_stale=true").hideStale).toBe(false);
    expect(decodeFilterState("hide_stale=0").hideStale).toBe(false);
    expect(decodeFilterState("").hideStale).toBe(false);
  });

  it("decodes show=saved|applied|ignored, ignores anything else", () => {
    expect(decodeFilterState("show=saved").showOnly).toBe("saved");
    expect(decodeFilterState("show=applied").showOnly).toBe("applied");
    expect(decodeFilterState("show=ignored").showOnly).toBe("ignored");
    expect(decodeFilterState("show=lol").showOnly).toBeUndefined();
    expect(decodeFilterState("").showOnly).toBeUndefined();
  });

  it("encodes showOnly when set, omits when undefined", () => {
    const params = new URLSearchParams(
      encodeFilterState({ ...DEFAULT_FILTER_STATE, showOnly: "saved" }),
    );
    expect(params.get("show")).toBe("saved");
    const params2 = new URLSearchParams(encodeFilterState(DEFAULT_FILTER_STATE));
    expect(params2.get("show")).toBeNull();
  });

  it("round-trips arbitrary valid filter states (property)", () => {
    const atsArb = fc.subarray([...ATS_IDS]);
    const levelArb = fc.subarray(
      LEVELS.filter((l) => l !== null) as ReadonlyArray<NonNullable<(typeof LEVELS)[number]>>,
    );
    const wtArb = fc.subarray([...WORKPLACE_TYPES]);
    const sortArb = fc.constantFrom(
      "posted_at:desc",
      "posted_at:asc",
      "first_seen:desc",
      "first_seen:asc",
      "company:asc",
      "company:desc",
      "level:asc",
      "level:desc",
    );
    const sinceArb = fc.constantFrom("24h", "7d", "30d", "all");
    fc.assert(
      fc.property(
        fc.record({
          q: fc
            .string({ minLength: 0, maxLength: 64 })
            .map((s) => s.replace(/[&=?#]/g, "x"))
            .filter((s) => {
              if (s.length === 0) return true;
              const words = s.match(/\w+/g) ?? [];
              if (words.length === 0) return false;
              return !words.every((w) => /^(?:AND|OR|NEAR)$/i.test(w));
            }),
          ats: atsArb,
          level: levelArb,
          wt: wtArb,
          since: sinceArb,
          hideRecruiter: fc.boolean(),
          hideStale: fc.boolean(),
          showOnly: fc.option(fc.constantFrom("saved", "applied", "ignored"), { nil: undefined }),
          page: fc.integer({ min: 1, max: 9999 }),
          sort: sortArb,
        }),
        (raw) => {
          const state: FilterState = {
            q: raw.q,
            ats: raw.ats,
            level: raw.level,
            wt: raw.wt,
            country: undefined,
            region: undefined,
            since: raw.since,
            hideRecruiter: raw.hideRecruiter,
            hideStale: raw.hideStale,
            showOnly: raw.showOnly,
            minComp: undefined,
            sort: raw.sort,
            page: raw.page,
          };
          const encoded = encodeFilterState(state);
          const decoded = decodeFilterState(encoded);
          return JSON.stringify(decoded) === JSON.stringify(state);
        },
      ),
      { numRuns: 50 },
    );
  });

  it("encoding then decoding never produces a different state object (property)", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (raw) => {
        const params = new URLSearchParams();
        params.set("q", raw);
        const decoded = decodeFilterState(params.toString());
        const reencoded = encodeFilterState(decoded);
        const redecoded = decodeFilterState(reencoded);
        return JSON.stringify(decoded) === JSON.stringify(redecoded);
      }),
      { numRuns: 50 },
    );
  });
});

describe("sameFilterState", () => {
  // A non-default state that exercises every comparable field. Used as the
  // baseline so each "field differs" case can toggle a single attribute
  // while everything else stays identical.
  const baseline: FilterState = {
    q: "engineer",
    ats: ["greenhouse", "lever"],
    level: ["senior", "staff"],
    wt: ["remote"],
    country: "US",
    region: "California",
    since: "7d",
    hideRecruiter: true,
    hideStale: true,
    showOnly: "saved",
    minComp: 150_000,
    sort: "first_seen:desc",
    page: 3,
  };

  it("returns true for the same reference", () => {
    expect(sameFilterState(baseline, baseline)).toBe(true);
  });

  it("returns true for two default states (the most common no-op)", () => {
    expect(sameFilterState(DEFAULT_FILTER_STATE, { ...DEFAULT_FILTER_STATE })).toBe(true);
  });

  it("returns true for two value-equal but distinct objects (the regression this fixes)", () => {
    const clone: FilterState = {
      ...baseline,
      ats: [...baseline.ats],
      level: [...baseline.level],
      wt: [...baseline.wt],
    };
    expect(clone).not.toBe(baseline);
    expect(sameFilterState(baseline, clone)).toBe(true);
  });

  it("returns false when q differs", () => {
    expect(sameFilterState(baseline, { ...baseline, q: "designer" })).toBe(false);
  });

  it("returns false when country differs", () => {
    expect(sameFilterState(baseline, { ...baseline, country: "GB" })).toBe(false);
    expect(sameFilterState(baseline, { ...baseline, country: undefined })).toBe(false);
  });

  it("returns false when region differs", () => {
    expect(sameFilterState(baseline, { ...baseline, region: "Texas" })).toBe(false);
    expect(sameFilterState(baseline, { ...baseline, region: undefined })).toBe(false);
  });

  it("returns false when since differs", () => {
    expect(sameFilterState(baseline, { ...baseline, since: "30d" })).toBe(false);
  });

  it("returns false when hideRecruiter differs", () => {
    expect(sameFilterState(baseline, { ...baseline, hideRecruiter: false })).toBe(false);
  });

  it("returns false when hideStale differs", () => {
    expect(sameFilterState(baseline, { ...baseline, hideStale: false })).toBe(false);
  });

  it("returns false when minComp differs", () => {
    expect(sameFilterState(baseline, { ...baseline, minComp: 200_000 })).toBe(false);
    expect(sameFilterState(baseline, { ...baseline, minComp: undefined })).toBe(false);
  });

  it("returns false when sort differs", () => {
    expect(sameFilterState(baseline, { ...baseline, sort: "posted_at:asc" })).toBe(false);
  });

  it("returns false when page differs", () => {
    expect(sameFilterState(baseline, { ...baseline, page: 4 })).toBe(false);
  });

  it("returns false when showOnly differs", () => {
    expect(sameFilterState(baseline, { ...baseline, showOnly: "applied" })).toBe(false);
    expect(sameFilterState(baseline, { ...baseline, showOnly: undefined })).toBe(false);
  });

  it("returns false when ats array has different elements", () => {
    expect(sameFilterState(baseline, { ...baseline, ats: ["greenhouse"] })).toBe(false);
    expect(sameFilterState(baseline, { ...baseline, ats: ["greenhouse", "ashby"] })).toBe(false);
  });

  it("returns false when ats array has the same elements in different order", () => {
    // Order matters because the URL canonicalization treats it as significant.
    expect(sameFilterState(baseline, { ...baseline, ats: ["lever", "greenhouse"] })).toBe(false);
  });

  it("returns false when level array differs", () => {
    expect(sameFilterState(baseline, { ...baseline, level: ["senior"] })).toBe(false);
    expect(sameFilterState(baseline, { ...baseline, level: ["staff", "senior"] })).toBe(false);
  });

  it("returns false when wt array differs", () => {
    expect(sameFilterState(baseline, { ...baseline, wt: [] })).toBe(false);
    expect(sameFilterState(baseline, { ...baseline, wt: ["hybrid"] })).toBe(false);
  });

  it("returns true when both arrays are empty (same-ref vs new empty)", () => {
    const a: FilterState = { ...DEFAULT_FILTER_STATE };
    const b: FilterState = { ...DEFAULT_FILTER_STATE, ats: [], level: [], wt: [] };
    expect(sameFilterState(a, b)).toBe(true);
  });

  it("is symmetric (property)", () => {
    fc.assert(
      fc.property(
        fc.record({
          q: fc.string({ maxLength: 20 }),
          page: fc.integer({ min: 1, max: 100 }),
          hideRecruiter: fc.boolean(),
          hideStale: fc.boolean(),
        }),
        (raw) => {
          const a: FilterState = { ...DEFAULT_FILTER_STATE, ...raw };
          const b: FilterState = { ...DEFAULT_FILTER_STATE, ...raw };
          return sameFilterState(a, b) === sameFilterState(b, a);
        },
      ),
      { numRuns: 50 },
    );
  });
});
