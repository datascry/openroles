import { describe, expect, it } from "bun:test";
import { LEVEL_RANK, LEVELS, LevelSchema, levelRank } from "./level.ts";

describe("LevelSchema", () => {
  it("accepts each canonical level and null", () => {
    for (const level of LEVELS) {
      expect(LevelSchema.parse(level)).toBe(level);
    }
    expect(LevelSchema.parse(null)).toBeNull();
  });

  it("rejects unknown levels", () => {
    expect(() => LevelSchema.parse("architect")).toThrow();
  });
});

describe("levelRank", () => {
  it("returns null for null", () => {
    expect(levelRank(null)).toBeNull();
  });

  it("returns the canonical rank for each level", () => {
    expect(levelRank("intern")).toBe(0);
    expect(levelRank("entry")).toBe(1);
    expect(levelRank("director")).toBe(9);
  });

  it("ranks are strictly monotonic across the canonical order", () => {
    const ranks = LEVELS.filter((l): l is NonNullable<typeof l> => l !== null).map(
      (l) => LEVEL_RANK[l],
    );
    for (let i = 1; i < ranks.length; i++) {
      const a = ranks[i - 1];
      const b = ranks[i];
      if (a === undefined || b === undefined) throw new Error("rank undefined");
      expect(b).toBeGreaterThan(a);
    }
  });
});
