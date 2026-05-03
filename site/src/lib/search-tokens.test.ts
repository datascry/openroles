import { describe, expect, it } from "bun:test";
import {
  decodePostingList,
  parseSearchIndex,
  queryStems,
  searchStems,
  stem,
  tokenize,
} from "./search-tokens.ts";

describe("tokenize", () => {
  it("splits on non-alphanumeric, lowercases", () => {
    expect(tokenize("Senior Backend Engineer")).toEqual(["senior", "backend", "engineer"]);
    expect(tokenize("Stripe (Inc.)")).toEqual(["stripe", "inc"]);
  });

  it("strips diacritics so accented variants normalise", () => {
    expect(tokenize("Café Résumé")).toEqual(["cafe", "resume"]);
  });

  it("returns an empty array for empty input or pure punctuation", () => {
    expect(tokenize("")).toEqual([]);
    expect(tokenize("!!!")).toEqual([]);
  });
});

describe("stem", () => {
  it("collapses common verb / agent suffixes", () => {
    expect(stem("engineer")).toBe(stem("engineering"));
    expect(stem("engineer")).toBe(stem("engineered"));
    expect(stem("manager")).toBe(stem("manage"));
    expect(stem("manager")).toBe(stem("managers"));
    expect(stem("designer")).toBe(stem("designed"));
    expect(stem("developer")).toBe(stem("developing"));
  });

  it("collapses plurals (-s, -sses → -ss)", () => {
    expect(stem("designs")).toBe(stem("design"));
    expect(stem("classes")).toBe(stem("class"));
  });

  it("leaves short tokens alone", () => {
    expect(stem("a")).toBe("a");
    expect(stem("the")).toBe("the");
    expect(stem("ios")).toBe("ios");
  });
});

describe("queryStems", () => {
  it("dedupes stems within the query", () => {
    expect(queryStems("engineer engineering engineer")).toEqual(["engin"]);
  });

  it("drops stop words and yields stems for content tokens", () => {
    const stems = queryStems("the senior engineer at stripe");
    expect(stems).not.toContain("the");
    expect(stems).not.toContain("at");
    // engineer → engin, stripe → strip (regardless of exact stemmer
    // shape, the content tokens come through.) Just assert there are
    // a handful of non-stop-word stems.
    expect(stems.length).toBeGreaterThanOrEqual(3);
    expect(stems.every((s) => s.length >= 2)).toBe(true);
  });

  it("returns [] for empty / stop-words-only", () => {
    expect(queryStems("")).toEqual([]);
    expect(queryStems("the and a")).toEqual([]);
  });
});

describe("decodePostingList", () => {
  it("decodes empty string to empty array", () => {
    expect(decodePostingList("")).toEqual([]);
  });

  it("decodes deltas and accumulates", () => {
    expect(decodePostingList("0,3,1,5")).toEqual([0, 3, 4, 9]);
  });

  it("uses base-36 digits", () => {
    // a (10) + 1 + 1 + 1 = [10, 11, 12, 13]
    expect(decodePostingList("a,1,1,1")).toEqual([10, 11, 12, 13]);
  });

  it("stops at the first un-parseable delta and returns what it has", () => {
    // Real garbage tokens are non-base-36; "!!!" parses to NaN so
    // decode bails after the prior valid entries.
    expect(decodePostingList("0,5,!!!,7")).toEqual([0, 5]);
  });
});

describe("parseSearchIndex", () => {
  it("decodes a small corpus", () => {
    const idx = parseSearchIndex({
      v: "1.0",
      n: 4,
      stems: { engin: "0,2,1", design: "1,2" },
    });
    expect(idx.total).toBe(4);
    expect(idx.postings.get("engin")).toEqual([0, 2, 3]);
    expect(idx.postings.get("design")).toEqual([1, 3]);
  });

  it("rejects non-object input", () => {
    expect(() => parseSearchIndex(null)).toThrow();
    expect(() => parseSearchIndex(42)).toThrow();
    expect(() => parseSearchIndex([])).toThrow();
  });

  it("rejects when n missing or stems wrong shape", () => {
    expect(() => parseSearchIndex({ v: "1.0", stems: {} })).toThrow(/missing.*n/);
    expect(() => parseSearchIndex({ v: "1.0", n: 1, stems: "no" })).toThrow(/stems must be/);
  });
});

describe("searchStems", () => {
  const idx = parseSearchIndex({
    v: "1.0",
    n: 5,
    // engin → rows [0, 2, 4]
    // senior → rows [0, 1]
    // design → rows [3, 4]
    stems: {
      engin: "0,2,2",
      senior: "0,1",
      design: "3,1",
    },
  });

  it("returns null for an empty / stop-words-only query", () => {
    expect(searchStems(idx, "")).toBeNull();
    expect(searchStems(idx, "the and a")).toBeNull();
  });

  it("returns the posting list for a single stem", () => {
    const r = searchStems(idx, "engineer");
    expect(r).toEqual(new Set([0, 2, 4]));
  });

  it("intersects multiple stems (AND semantics)", () => {
    // engineer AND senior → rows in both [0,2,4] ∩ [0,1] = {0}
    expect(searchStems(idx, "senior engineer")).toEqual(new Set([0]));
  });

  it("returns empty set when any stem misses", () => {
    expect(searchStems(idx, "engineer rust")).toEqual(new Set());
  });

  it("stems the query before lookup so engineer matches engin", () => {
    expect(searchStems(idx, "engineering")).toEqual(new Set([0, 2, 4]));
  });
});
