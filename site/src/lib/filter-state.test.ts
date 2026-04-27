import { describe, expect, it } from "bun:test";
import { ATS_IDS, LEVELS, WORKPLACE_TYPES } from "@openroles/shared";
import fc from "fast-check";
import {
  DEFAULT_FILTER_STATE,
  decodeFilterState,
  encodeFilterState,
  type FilterState,
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
    expect(s.sort).toBe("posted_at:desc");
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
      "company:asc",
      "company:desc",
      "level:asc",
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
