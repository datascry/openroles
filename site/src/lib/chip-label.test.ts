import { describe, expect, it } from "bun:test";
import * as fc from "fast-check";
import { sanitizeChipLabel } from "./chip-label.ts";

describe("sanitizeChipLabel", () => {
  it("returns the input verbatim when already safe and short", () => {
    expect(sanitizeChipLabel("senior engineer")).toBe("senior engineer");
  });

  it("strips ASCII control characters", () => {
    expect(sanitizeChipLabel("hello\x00world")).toBe("helloworld");
    expect(sanitizeChipLabel("a\x07b\x1Fc\x7Fd")).toBe("abcd");
  });

  it("strips bidi override characters (U+202A-202E)", () => {
    expect(sanitizeChipLabel("safe‮evil")).toBe("safeevil");
  });

  it("strips zero-width space and zero-width joiner", () => {
    expect(sanitizeChipLabel("hi​there")).toBe("hithere");
  });

  it("collapses whitespace runs", () => {
    expect(sanitizeChipLabel("a   b\t\tc\n\nd")).toBe("a b c d");
  });

  it("trims leading and trailing whitespace", () => {
    expect(sanitizeChipLabel("   padded   ")).toBe("padded");
  });

  it("truncates with an ellipsis when over 32 chars", () => {
    const long = "a".repeat(40);
    const out = sanitizeChipLabel(long);
    expect(out.length).toBe(32);
    expect(out.endsWith("…")).toBe(true);
  });

  it("returns empty string when input is only control characters", () => {
    expect(sanitizeChipLabel("\x00\x01\x02")).toBe("");
  });

  describe("invariants (fast-check)", () => {
    it("output never contains ASCII control characters", () => {
      fc.assert(
        fc.property(fc.string(), (s) => {
          const out = sanitizeChipLabel(s);
          // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting the absence of control chars is the test's contract
          expect(/[\x00-\x1F\x7F]/.test(out)).toBe(false);
        }),
      );
    });

    it("output is bounded at 32 characters", () => {
      fc.assert(
        fc.property(fc.string(), (s) => {
          expect(sanitizeChipLabel(s).length).toBeLessThanOrEqual(32);
        }),
      );
    });

    it("output is idempotent (sanitize ∘ sanitize = sanitize)", () => {
      fc.assert(
        fc.property(fc.string(), (s) => {
          const once = sanitizeChipLabel(s);
          const twice = sanitizeChipLabel(once);
          expect(twice).toBe(once);
        }),
      );
    });
  });
});
