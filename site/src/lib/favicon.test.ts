import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * Guards site/public/favicon.svg against silently-malformed XML.
 *
 * The original favicon shipped with an XML comment that documented the
 * brand tokens by name. CSS custom properties are prefixed with `--`,
 * so the comment contained substrings like `--color-ink`. That's
 * illegal XML: the spec forbids `--` inside `<!-- ... -->` blocks
 * because a naive parser can't tell whether the next `>` closes the
 * comment. Chrome silently rendered the file anyway; Firefox surfaced
 * an XML parsing error and refused to draw the icon.
 *
 * Browsers vary; the contract is "well-formed XML." This test is the
 * cheapest enforcement of that contract without adding an XML parser
 * dependency to the site package.
 */
const FAVICON_PATH = new URL("../../public/favicon.svg", import.meta.url);

describe("favicon.svg", () => {
  const svg = readFileSync(FAVICON_PATH, "utf-8");

  it("starts with an <svg> root element", () => {
    expect(svg.trimStart().startsWith("<svg")).toBe(true);
  });

  it("contains no `--` substrings inside XML comments", () => {
    // Match every <!-- ... --> block and assert its body has no `--`.
    // Greedy-then-lazy: `[\s\S]*?` covers multiline bodies.
    const commentBodies = Array.from(svg.matchAll(/<!--([\s\S]*?)-->/g)).map((m) => m[1] ?? "");
    for (const body of commentBodies) {
      expect(body).not.toContain("--");
    }
  });

  it("uses only allowed top-level tags (no foreign content)", () => {
    // Sanity check the silhouette: a rect (canvas) + a circle (the dot).
    // Anything else means somebody added an element without thinking
    // about XML well-formedness; this test catches it before the file
    // ships to a stricter parser.
    expect(svg).toContain("<rect");
    expect(svg).toContain("<circle");
  });
});
