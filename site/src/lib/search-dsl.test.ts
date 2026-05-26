import { describe, expect, it } from "bun:test";
import * as fc from "fast-check";
import {
  composeQuery,
  hasStructured,
  parseQuery,
  Q_TOTAL_MAX,
  type StructuredQuery,
  sameQuery,
} from "./search-dsl.ts";

// Broad arbitrary: allows colons, embedded quotes (which composeQuery strips),
// and surrounding whitespace (which composeQuery trims). `\` is kept out
// because the underlying search-parser already escapes it, and `\n` because
// SQLite FTS5 phrase tokenisation drops newlines anyway.
const fieldValueArb = fc.string({ minLength: 0, maxLength: 32 }).filter((s) => !/[\\\n\r]/.test(s));

const structuredArb: fc.Arbitrary<StructuredQuery> = fc.record({
  title: fieldValueArb,
  company: fieldValueArb,
  location: fieldValueArb,
  freeText: fieldValueArb,
});

/**
 * Mirror the cleanup `composeQuery` performs so the property test asserts
 * the right invariant (round-trip yields the *normalised* form).
 */
function normaliseField(v: string): string {
  return v.replace(/"/g, "").trim();
}
function normaliseFreeText(v: string): string {
  return v.replace(/"/g, "").trim();
}

describe("parseQuery", () => {
  it("returns all-empty for empty input", () => {
    expect(parseQuery("")).toEqual({ title: "", company: "", location: "", freeText: "" });
  });

  it("extracts a single bare-word free-text term", () => {
    expect(parseQuery("engineer").freeText).toBe("engineer");
  });

  it("extracts title:value", () => {
    expect(parseQuery("title:engineer").title).toBe("engineer");
  });

  it("extracts company:stripe", () => {
    expect(parseQuery("company:stripe").company).toBe("stripe");
  });

  it("extracts location:remote", () => {
    expect(parseQuery("location:remote").location).toBe("remote");
  });

  it("extracts a quoted multi-word value", () => {
    const out = parseQuery('title:"senior engineer"');
    expect(out.title).toBe("senior engineer");
  });

  it("preserves a quoted phrase in free-text", () => {
    const out = parseQuery('"senior engineer"');
    expect(out.freeText).toBe("senior engineer");
  });

  it("treats unknown field prefix as a free-text token (literal `xyz:foo`)", () => {
    const out = parseQuery("xyz:engineer");
    expect(out.freeText).toBe("xyz:engineer");
  });

  it("handles a mixed query with structured + free-text remainder", () => {
    const out = parseQuery("title:engineer staff at company:stripe");
    expect(out.title).toBe("engineer");
    expect(out.company).toBe("stripe");
    expect(out.freeText).toBe("staff at");
    expect(out.location).toBe("");
  });

  it("concatenates duplicate field tokens with a single space", () => {
    const out = parseQuery("title:senior title:engineer");
    expect(out.title).toBe("senior engineer");
  });
});

describe("composeQuery", () => {
  it("returns empty string for an empty StructuredQuery", () => {
    expect(composeQuery({ title: "", company: "", location: "", freeText: "" })).toBe("");
  });

  it("always quotes field tokens (round-trip safety)", () => {
    expect(composeQuery({ title: "engineer", company: "", location: "", freeText: "" })).toBe(
      'title:"engineer"',
    );
    expect(
      composeQuery({ title: "senior engineer", company: "", location: "", freeText: "" }),
    ).toBe('title:"senior engineer"');
  });

  it("emits structured tokens before the free-text remainder", () => {
    expect(
      composeQuery({
        title: "engineer",
        company: "",
        location: "remote",
        freeText: "fulltime",
      }),
    ).toBe('title:"engineer" location:"remote" fulltime');
  });

  it("throws when the composed length exceeds Q_TOTAL_MAX", () => {
    const long = "x".repeat(Q_TOTAL_MAX);
    expect(() => composeQuery({ title: long, company: "", location: "", freeText: long })).toThrow(
      /exceeds 256/,
    );
  });
});

describe("round-trip (property)", () => {
  it("parseQuery yields the normalised form for any StructuredQuery value", () => {
    fc.assert(
      fc.property(structuredArb, (s) => {
        const composed = composeQuery(s);
        const reparsed = parseQuery(composed);
        expect(reparsed.title).toBe(normaliseField(s.title));
        expect(reparsed.company).toBe(normaliseField(s.company));
        expect(reparsed.location).toBe(normaliseField(s.location));
        expect(reparsed.freeText).toBe(normaliseFreeText(s.freeText));
      }),
    );
  });

  it("composeQuery output never exceeds Q_TOTAL_MAX when each field is short", () => {
    const short = fc.string({ maxLength: 20 }).filter((s) => !/[\\\n\r]/.test(s));
    fc.assert(
      fc.property(
        fc.record({ title: short, company: short, location: short, freeText: short }),
        (s) => {
          const composed = composeQuery(s);
          expect(composed.length).toBeLessThanOrEqual(Q_TOTAL_MAX);
        },
      ),
    );
  });

  it("freeText that looks like field:value is quoted so the parser does not re-bucket", () => {
    const composed = composeQuery({
      title: "",
      company: "",
      location: "",
      freeText: "title:hijack",
    });
    expect(composed).toBe('"title:hijack"');
    const reparsed = parseQuery(composed);
    expect(reparsed.title).toBe("");
    expect(reparsed.freeText).toBe("title:hijack");
  });

  it("strips embedded double-quotes from field values (lossy by design)", () => {
    const composed = composeQuery({
      title: 'sen"ior',
      company: "",
      location: "",
      freeText: "",
    });
    expect(composed).toBe('title:"senior"');
    const reparsed = parseQuery(composed);
    expect(reparsed.title).toBe("senior");
  });

  it("trims whitespace inside field values (round-trip yields trimmed value)", () => {
    const composed = composeQuery({
      title: "  engineer  ",
      company: "",
      location: "",
      freeText: "",
    });
    const reparsed = parseQuery(composed);
    expect(reparsed.title).toBe("engineer");
  });
});

describe("hasStructured", () => {
  it("is false when no structured field is set", () => {
    expect(hasStructured({ title: "", company: "", location: "", freeText: "freeonly" })).toBe(
      false,
    );
  });

  it("is true when any structured field is non-empty", () => {
    expect(hasStructured({ title: "x", company: "", location: "", freeText: "" })).toBe(true);
    expect(hasStructured({ title: "", company: "x", location: "", freeText: "" })).toBe(true);
    expect(hasStructured({ title: "", company: "", location: "x", freeText: "" })).toBe(true);
  });
});

describe("sameQuery", () => {
  const empty: StructuredQuery = { title: "", company: "", location: "", freeText: "" };

  it("is true for identical queries", () => {
    expect(sameQuery(empty, empty)).toBe(true);
    const q: StructuredQuery = {
      title: "engineer",
      company: "stripe",
      location: "berlin",
      freeText: "rust",
    };
    expect(sameQuery(q, { ...q })).toBe(true);
  });

  it("is true for canonical-no-op round-trips (the regression this fixes)", () => {
    // User types `company:stripe title:engineer` — composer emits
    // `title:"engineer" company:"stripe"` (canonical field order +
    // quoted values). The composed string differs from the input,
    // but the PARSED forms are identical.
    const userTyped = "company:stripe title:engineer";
    const canonical = composeQuery(parseQuery(userTyped));
    expect(canonical).not.toBe(userTyped); // composer reordered + quoted
    expect(sameQuery(parseQuery(canonical), parseQuery(userTyped))).toBe(true);
  });

  it("is true after parse→compose→parse round-trip for any input", () => {
    fc.assert(
      fc.property(
        fc.record({
          title: fc.string({ minLength: 0, maxLength: 30 }).map((s) => s.replace(/"/g, "")),
          company: fc.string({ minLength: 0, maxLength: 30 }).map((s) => s.replace(/"/g, "")),
          location: fc.string({ minLength: 0, maxLength: 30 }).map((s) => s.replace(/"/g, "")),
          freeText: fc.string({ minLength: 0, maxLength: 30 }).map((s) => s.replace(/"/g, "")),
        }),
        (raw) => {
          // Filter to keep composed length under cap
          const trimmed: StructuredQuery = {
            title: raw.title.trim().slice(0, 20),
            company: raw.company.trim().slice(0, 20),
            location: raw.location.trim().slice(0, 20),
            freeText: raw.freeText.trim().slice(0, 20),
          };
          let composed: string;
          try {
            composed = composeQuery(trimmed);
          } catch {
            return true; // skip overflows
          }
          return sameQuery(parseQuery(composed), trimmed);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("is false when title differs", () => {
    expect(sameQuery({ ...empty, title: "a" }, { ...empty, title: "b" })).toBe(false);
  });

  it("is false when company differs", () => {
    expect(sameQuery({ ...empty, company: "a" }, { ...empty, company: "b" })).toBe(false);
  });

  it("is false when location differs", () => {
    expect(sameQuery({ ...empty, location: "a" }, { ...empty, location: "b" })).toBe(false);
  });

  it("is false when freeText differs", () => {
    expect(sameQuery({ ...empty, freeText: "a" }, { ...empty, freeText: "b" })).toBe(false);
  });
});
