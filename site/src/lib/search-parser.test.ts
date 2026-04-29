import { describe, expect, it } from "bun:test";
import * as fc from "fast-check";
import {
  buildFtsExpression,
  escapeLike,
  extractLocationValues,
  parseSearchInput,
} from "./search-parser.ts";

describe("parseSearchInput", () => {
  describe("bare terms", () => {
    it("returns one token for a single bare word", () => {
      expect(parseSearchInput("engineer")).toEqual([{ field: undefined, value: "engineer" }]);
    });

    it("splits whitespace-separated bare words into separate tokens", () => {
      expect(parseSearchInput("senior engineer")).toEqual([
        { field: undefined, value: "senior" },
        { field: undefined, value: "engineer" },
      ]);
    });

    it("returns an empty list for empty / whitespace-only input", () => {
      expect(parseSearchInput("")).toEqual([]);
      expect(parseSearchInput("   \t\n")).toEqual([]);
    });
  });

  describe("quoted phrases", () => {
    it("treats a quoted phrase as a single token", () => {
      expect(parseSearchInput('"senior engineer"')).toEqual([
        { field: undefined, value: "senior engineer" },
      ]);
    });

    it("preserves internal whitespace in quoted phrases", () => {
      expect(parseSearchInput('"  senior   engineer  "')).toEqual([
        { field: undefined, value: "senior   engineer" },
      ]);
    });

    it("drops empty quoted phrases", () => {
      expect(parseSearchInput('""')).toEqual([]);
    });
  });

  describe("field-scoped tokens", () => {
    it("recognizes title, company, description, and location", () => {
      expect(
        parseSearchInput("title:engineer company:stripe description:remote location:austin"),
      ).toEqual([
        { field: "title", value: "engineer" },
        { field: "company", value: "stripe" },
        { field: "description", value: "remote" },
        { field: "location", value: "austin" },
      ]);
    });

    it('supports field:"quoted value"', () => {
      expect(parseSearchInput('title:"senior engineer" company:stripe')).toEqual([
        { field: "title", value: "senior engineer" },
        { field: "company", value: "stripe" },
      ]);
    });

    it("falls back to a literal bare-term for unknown fields", () => {
      expect(parseSearchInput("xyz:engineer")).toEqual([
        { field: undefined, value: "xyz:engineer" },
      ]);
    });

    it("falls back to a literal bare-term for unknown fields with quoted values", () => {
      expect(parseSearchInput('xyz:"senior engineer"')).toEqual([
        { field: undefined, value: "xyz:senior engineer" },
      ]);
    });

    it("drops field-scoped tokens with empty values", () => {
      expect(parseSearchInput("title: company:stripe")).toEqual([
        { field: "company", value: "stripe" },
      ]);
    });
  });

  describe("mixed input", () => {
    it("interleaves bare terms with field-scoped tokens", () => {
      expect(parseSearchInput("senior title:engineer stripe")).toEqual([
        { field: undefined, value: "senior" },
        { field: "title", value: "engineer" },
        { field: undefined, value: "stripe" },
      ]);
    });
  });

  describe("safety", () => {
    it("bounds the result at 16 tokens", () => {
      const input = Array.from({ length: 32 }, (_, i) => `t${i}`).join(" ");
      expect(parseSearchInput(input)).toHaveLength(16);
    });

    it("ignores non-string input gracefully", () => {
      // biome-ignore lint/suspicious/noExplicitAny: testing runtime defense
      expect(parseSearchInput(undefined as any)).toEqual([]);
      // biome-ignore lint/suspicious/noExplicitAny: testing runtime defense
      expect(parseSearchInput(null as any)).toEqual([]);
    });
  });
});

describe("buildFtsExpression", () => {
  it("returns null when no FTS-indexed tokens are present", () => {
    expect(buildFtsExpression([])).toBeNull();
    expect(buildFtsExpression([{ field: "location", value: "remote" }])).toBeNull();
  });

  it("emits a quoted phrase for a bare token", () => {
    expect(buildFtsExpression([{ field: undefined, value: "engineer" }])).toBe('"engineer"');
  });

  it("doubles internal quotes per FTS5 grammar", () => {
    expect(buildFtsExpression([{ field: undefined, value: 'a"b' }])).toBe('"a""b"');
  });

  it("emits a column-scoped phrase for a field-scoped token", () => {
    expect(buildFtsExpression([{ field: "title", value: "engineer" }])).toBe('{title}: "engineer"');
  });

  it("maps description → description_excerpt column", () => {
    expect(buildFtsExpression([{ field: "description", value: "remote" }])).toBe(
      '{description_excerpt}: "remote"',
    );
  });

  it("AND-joins multiple tokens", () => {
    expect(
      buildFtsExpression([
        { field: "title", value: "senior" },
        { field: "company", value: "stripe" },
      ]),
    ).toBe('{title}: "senior" AND {company}: "stripe"');
  });

  it("skips location tokens but keeps the rest", () => {
    expect(
      buildFtsExpression([
        { field: "title", value: "senior" },
        { field: "location", value: "remote" },
        { field: undefined, value: "engineer" },
      ]),
    ).toBe('{title}: "senior" AND "engineer"');
  });

  describe("FTS5 injection safety (fast-check)", () => {
    it("output never contains an unquoted FTS5 operator", () => {
      fc.assert(
        fc.property(fc.string({ maxLength: 100 }), (s) => {
          const expr = buildFtsExpression(parseSearchInput(s));
          if (expr === null) return;
          // FTS5 operators outside quotes would let the user inject. Our
          // emit path always wraps values in `"..."` and only puts AND
          // *between* phrases. So in the emitted string, the only
          // out-of-quote operator should be the literal AND we emit.
          // Verify by stripping `"..."` (with internal "" doubled) and
          // checking what remains is AND-separated phrases or a column
          // prefix `{col}: `.
          const stripped = expr.replace(/"(?:[^"]|"")*"/g, "X");
          // Stripped form: alternation of column-prefixed Xs and bare Xs
          // joined by " AND ". Anything with an injected NEAR/OR/^/*/
          // outside a phrase shows up here.
          const okShape = /^(\{[a-z_]+\}:\s)?X(\sAND\s(\{[a-z_]+\}:\s)?X)*$/;
          expect(stripped).toMatch(okShape);
        }),
        { numRuns: 100 },
      );
    });
  });
});

describe("extractLocationValues", () => {
  it("returns only location-field values, in order", () => {
    expect(
      extractLocationValues([
        { field: "title", value: "engineer" },
        { field: "location", value: "remote" },
        { field: undefined, value: "x" },
        { field: "location", value: "austin" },
      ]),
    ).toEqual(["remote", "austin"]);
  });

  it("returns empty when no location tokens are present", () => {
    expect(extractLocationValues([{ field: "title", value: "engineer" }])).toEqual([]);
  });
});

describe("escapeLike", () => {
  it("escapes %, _, and [ to literal-class form", () => {
    expect(escapeLike("50%")).toBe("50\\%");
    expect(escapeLike("a_b")).toBe("a\\_b");
    expect(escapeLike("a[b")).toBe("a\\[b");
  });

  it("escapes backslash first to avoid double-escaping", () => {
    expect(escapeLike("a\\b")).toBe("a\\\\b");
    // % after a literal backslash stays escaped exactly once.
    expect(escapeLike("a\\%b")).toBe("a\\\\\\%b");
  });

  it("leaves ordinary text unchanged", () => {
    expect(escapeLike("San Francisco")).toBe("San Francisco");
    expect(escapeLike("UK & Ireland")).toBe("UK & Ireland");
  });

  describe("invariants (fast-check)", () => {
    it("escaped output, when wrapped with %, never produces wildcards from user input", () => {
      fc.assert(
        fc.property(fc.string({ maxLength: 100 }), (s) => {
          const escaped = escapeLike(s);
          // After escaping, every original % / _ / [ is preceded by an
          // odd number of backslashes (escaped), and any literal
          // backslashes appear in pairs.
          // Simpler invariant: %\\* must always be even-backslashes-then-%
          // when % was originally present. Easiest to check: count the
          // pre-escape % vs post-escape unescaped %.
          const originalSpecial = (s.match(/[%_[]/g) ?? []).length;
          const unescapedSpecial = (escaped.match(/(?<!\\)(?:\\\\)*[%_[]/g) ?? []).filter((m) => {
            // The match's last char is %, _, or [. Check the char before
            // the trailing wildcard is part of an even number of \.
            const wildcard = m[m.length - 1];
            const slashes = m.length - 1; // chars before the wildcard are all \
            // Every pair of slashes is one literal backslash; if
            // slashes is even, the wildcard is unescaped.
            return slashes % 2 === 0 && (wildcard === "%" || wildcard === "_" || wildcard === "[");
          }).length;
          expect(unescapedSpecial).toBe(0);
          expect(originalSpecial).toBeGreaterThanOrEqual(0);
        }),
        { numRuns: 100 },
      );
    });
  });
});
