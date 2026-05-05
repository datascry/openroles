import { describe, expect, it } from "bun:test";
import { ATS_IDS, LEVELS, WORKPLACE_TYPES } from "@openroles/shared/constants";
import * as fc from "fast-check";
import {
  activeCountFor,
  FILTER_GROUPS,
  type FilterGroup,
  totalActiveCount,
} from "./filter-active-count.ts";
import { DEFAULT_FILTER_STATE, type FilterState } from "./filter-state.ts";

const NON_NULL_LEVELS = LEVELS.filter((l): l is NonNullable<(typeof LEVELS)[number]> => l !== null);

const filterStateArbitrary: fc.Arbitrary<FilterState> = fc.record({
  q: fc.string({ maxLength: 32 }),
  ats: fc.uniqueArray(fc.constantFrom(...ATS_IDS), { maxLength: 5 }),
  level: fc.uniqueArray(fc.constantFrom(...NON_NULL_LEVELS), { maxLength: 5 }),
  wt: fc.uniqueArray(fc.constantFrom(...WORKPLACE_TYPES), { maxLength: 3 }),
  country: fc.option(fc.constantFrom("US", "GB", "DE"), { nil: undefined }),
  region: fc.option(fc.constant("CA"), { nil: undefined }),
  since: fc.constantFrom("24h", "7d", "30d", "90d", "all"),
  hideRecruiter: fc.boolean(),
  hideStale: fc.boolean(),
  minComp: fc.option(fc.integer({ min: 0, max: 500_000 }), { nil: undefined }),
  sort: fc.constantFrom("posted_at:desc", "posted_at:asc", "company:asc"),
  page: fc.integer({ min: 1, max: 10 }),
  showOnly: fc.option(fc.constantFrom("saved", "applied", "ignored"), { nil: undefined }),
}) as fc.Arbitrary<FilterState>;

describe("filter-active-count", () => {
  describe("activeCountFor (deterministic units)", () => {
    it("default state has zero for every group (default since counts as no narrowing)", () => {
      for (const group of FILTER_GROUPS) {
        expect(activeCountFor(group, DEFAULT_FILTER_STATE)).toBe(0);
      }
    });

    it("counts a non-empty search query as 1", () => {
      const state: FilterState = { ...DEFAULT_FILTER_STATE, q: "engineer" };
      expect(activeCountFor("search", state)).toBe(1);
    });

    it("counts each multi-select selection in ats / level / wt", () => {
      const state: FilterState = {
        ...DEFAULT_FILTER_STATE,
        ats: ["greenhouse", "lever", "ashby"],
        level: ["senior", "staff"],
        wt: ["remote"],
      };
      expect(activeCountFor("ats", state)).toBe(3);
      expect(activeCountFor("level", state)).toBe(2);
      expect(activeCountFor("wt", state)).toBe(1);
    });

    it("counts posted as 1 when since differs from the runtime default", () => {
      // The default is "all" — any narrowed window counts as active.
      expect(activeCountFor("posted", { ...DEFAULT_FILTER_STATE, since: "all" })).toBe(0);
      expect(activeCountFor("posted", { ...DEFAULT_FILTER_STATE, since: "24h" })).toBe(1);
      expect(activeCountFor("posted", { ...DEFAULT_FILTER_STATE, since: "7d" })).toBe(1);
      expect(activeCountFor("posted", { ...DEFAULT_FILTER_STATE, since: "30d" })).toBe(1);
      expect(activeCountFor("posted", { ...DEFAULT_FILTER_STATE, since: "90d" })).toBe(1);
    });

    it("treats minComp = 0 as no filter (spec §2.7.d)", () => {
      expect(activeCountFor("minComp", { ...DEFAULT_FILTER_STATE, minComp: 0 })).toBe(0);
      expect(activeCountFor("minComp", { ...DEFAULT_FILTER_STATE, minComp: 1 })).toBe(1);
      expect(activeCountFor("minComp", { ...DEFAULT_FILTER_STATE, minComp: 200_000 })).toBe(1);
    });

    it("status sums the two boolean toggles (0–2)", () => {
      expect(activeCountFor("status", DEFAULT_FILTER_STATE)).toBe(0);
      expect(activeCountFor("status", { ...DEFAULT_FILTER_STATE, hideRecruiter: true })).toBe(1);
      expect(activeCountFor("status", { ...DEFAULT_FILTER_STATE, hideStale: true })).toBe(1);
      expect(
        activeCountFor("status", {
          ...DEFAULT_FILTER_STATE,
          hideRecruiter: true,
          hideStale: true,
        }),
      ).toBe(2);
    });

    it("personal counts a present showOnly value as 1", () => {
      expect(activeCountFor("personal", DEFAULT_FILTER_STATE)).toBe(0);
      expect(activeCountFor("personal", { ...DEFAULT_FILTER_STATE, showOnly: "saved" })).toBe(1);
      expect(activeCountFor("personal", { ...DEFAULT_FILTER_STATE, showOnly: "applied" })).toBe(1);
      expect(activeCountFor("personal", { ...DEFAULT_FILTER_STATE, showOnly: "ignored" })).toBe(1);
    });
  });

  describe("totalActiveCount (property)", () => {
    it("equals the sum of every per-group count for any state", () => {
      fc.assert(
        fc.property(filterStateArbitrary, (state) => {
          const partSum = FILTER_GROUPS.reduce<number>(
            (sum, g) => sum + activeCountFor(g, state),
            0,
          );
          expect(totalActiveCount(state)).toBe(partSum);
        }),
      );
    });

    it("is always non-negative", () => {
      fc.assert(
        fc.property(filterStateArbitrary, (state) => {
          expect(totalActiveCount(state)).toBeGreaterThanOrEqual(0);
        }),
      );
    });

    it("totals match the per-group sum on default state and on arbitrary states", () => {
      // The default state has `since: "all"` (matches masthead total) and
      // every other group is empty, so the total active count is 0.
      expect(totalActiveCount(DEFAULT_FILTER_STATE)).toBe(0);
      fc.assert(
        fc.property(filterStateArbitrary, (state) => {
          const anyActive = FILTER_GROUPS.some((g: FilterGroup) => activeCountFor(g, state) > 0);
          if (anyActive) {
            expect(totalActiveCount(state)).toBeGreaterThan(0);
          } else {
            expect(totalActiveCount(state)).toBe(0);
          }
        }),
      );
    });
  });
});
