import { describe, expect, it } from "bun:test";
import * as fc from "fast-check";
import { type PageToken, pagesToShow } from "./pager.ts";

describe("pagesToShow", () => {
  describe("small totals (≤ 7)", () => {
    it("returns the full sequence when total = 1", () => {
      expect(pagesToShow(1, 1)).toEqual([1]);
    });
    it("returns the full sequence when total = 5", () => {
      expect(pagesToShow(3, 5)).toEqual([1, 2, 3, 4, 5]);
    });
    it("returns the full sequence when total = 7 (the boundary)", () => {
      expect(pagesToShow(4, 7)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    });
  });

  describe("large totals (> 7) — head", () => {
    it("expands the head window when current ≤ 3", () => {
      // Spec for current=1, total=20: 1,2,3,4 ... 19,20 (close pair to total)
      const result = pagesToShow(1, 20);
      expect(result).toEqual([1, 2, 3, 4, "ellipsis", 19, 20]);
    });
    it("expands the head window when current = 3", () => {
      const result = pagesToShow(3, 20);
      expect(result).toEqual([1, 2, 3, 4, "ellipsis", 19, 20]);
    });
  });

  describe("large totals (> 7) — tail", () => {
    it("expands the tail window when current = total", () => {
      const result = pagesToShow(20, 20);
      expect(result).toEqual([1, 2, "ellipsis", 17, 18, 19, 20]);
    });
    it("expands the tail window when current = total - 2", () => {
      const result = pagesToShow(18, 20);
      expect(result).toEqual([1, 2, "ellipsis", 17, 18, 19, 20]);
    });
  });

  describe("large totals (> 7) — middle", () => {
    it("renders 1, …, current-1, current, current+1, …, total", () => {
      const result = pagesToShow(10, 20);
      expect(result).toEqual([1, "ellipsis", 9, 10, 11, "ellipsis", 20]);
    });
  });

  describe("input validation", () => {
    it("rejects total < 1", () => {
      expect(() => pagesToShow(1, 0)).toThrow();
      expect(() => pagesToShow(1, -3)).toThrow();
    });
    it("rejects non-integer total", () => {
      expect(() => pagesToShow(1, 1.5)).toThrow();
    });
    it("rejects current < 1", () => {
      expect(() => pagesToShow(0, 10)).toThrow();
    });
    it("rejects current > total", () => {
      expect(() => pagesToShow(11, 10)).toThrow();
    });
  });

  describe("invariants (fast-check)", () => {
    const validInput = fc
      .integer({ min: 1, max: 1000 })
      .chain((total) => fc.integer({ min: 1, max: total }).map((current) => ({ current, total })));

    it("every numeric token lies in [1, total]", () => {
      fc.assert(
        fc.property(validInput, ({ current, total }) => {
          for (const tok of pagesToShow(current, total)) {
            if (typeof tok === "number") {
              expect(tok).toBeGreaterThanOrEqual(1);
              expect(tok).toBeLessThanOrEqual(total);
            }
          }
        }),
      );
    });

    it("numeric tokens are strictly increasing", () => {
      fc.assert(
        fc.property(validInput, ({ current, total }) => {
          let prev = 0;
          for (const tok of pagesToShow(current, total)) {
            if (typeof tok === "number") {
              expect(tok).toBeGreaterThan(prev);
              prev = tok;
            }
          }
        }),
      );
    });

    it("contains 1 and total when total ≥ 1", () => {
      fc.assert(
        fc.property(validInput, ({ current, total }) => {
          const tokens = pagesToShow(current, total);
          expect(tokens).toContain(1 as PageToken);
          expect(tokens).toContain(total as PageToken);
        }),
      );
    });

    it("ellipsis appears only between non-adjacent numeric tokens", () => {
      fc.assert(
        fc.property(validInput, ({ current, total }) => {
          const tokens = pagesToShow(current, total);
          for (let i = 0; i < tokens.length; i++) {
            if (tokens[i] === "ellipsis") {
              const before = tokens[i - 1];
              const after = tokens[i + 1];
              expect(typeof before).toBe("number");
              expect(typeof after).toBe("number");
              expect((after as number) - (before as number)).toBeGreaterThan(1);
            }
          }
        }),
      );
    });

    it("never has two consecutive ellipsis tokens", () => {
      fc.assert(
        fc.property(validInput, ({ current, total }) => {
          const tokens = pagesToShow(current, total);
          for (let i = 1; i < tokens.length; i++) {
            if (tokens[i] === "ellipsis" && tokens[i - 1] === "ellipsis") {
              throw new Error(`adjacent ellipsis at i=${i}: ${JSON.stringify(tokens)}`);
            }
          }
        }),
      );
    });

    it("returns the full [1..total] sequence when total ≤ 7", () => {
      fc.assert(
        fc.property(
          fc
            .integer({ min: 1, max: 7 })
            .chain((total) =>
              fc.integer({ min: 1, max: total }).map((current) => ({ current, total })),
            ),
          ({ current, total }) => {
            const tokens = pagesToShow(current, total);
            const expected = Array.from({ length: total }, (_, i) => i + 1);
            expect(tokens).toEqual(expected);
          },
        ),
      );
    });
  });
});
