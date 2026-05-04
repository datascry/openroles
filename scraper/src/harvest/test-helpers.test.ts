import { describe, expect, it } from "bun:test";
import { urlHostIs, urlHostMatches } from "./test-helpers.ts";

describe("urlHostIs", () => {
  it("returns true for an exact host match", () => {
    expect(urlHostIs("https://boards-api.greenhouse.io/v1/jobs", "boards-api.greenhouse.io")).toBe(
      true,
    );
  });

  it("returns false for a different host", () => {
    expect(urlHostIs("https://attacker.example.com/", "boards-api.greenhouse.io")).toBe(false);
  });

  it("returns false for a subdomain (strict — exact match only)", () => {
    expect(urlHostIs("https://api.boards-api.greenhouse.io/", "boards-api.greenhouse.io")).toBe(
      false,
    );
  });

  it("rejects a host smuggled in the path of an attacker URL", () => {
    // The original `url.includes("boards-api.greenhouse.io")` would match
    // this; the parsed hostname approach correctly returns false.
    expect(
      urlHostIs(
        "https://attacker.example.com/?x=boards-api.greenhouse.io",
        "boards-api.greenhouse.io",
      ),
    ).toBe(false);
  });

  it("returns false for a malformed URL rather than throwing", () => {
    expect(urlHostIs("not-a-valid-url", "boards-api.greenhouse.io")).toBe(false);
    expect(urlHostIs("", "boards-api.greenhouse.io")).toBe(false);
  });
});

describe("urlHostMatches", () => {
  it("returns true for an exact host match", () => {
    expect(urlHostMatches("https://commoncrawl.org/", "commoncrawl.org")).toBe(true);
  });

  it("returns true for a subdomain match", () => {
    expect(urlHostMatches("https://data.commoncrawl.org/", "commoncrawl.org")).toBe(true);
    expect(urlHostMatches("https://index.commoncrawl.org/", "commoncrawl.org")).toBe(true);
  });

  it("returns false for a non-matching host", () => {
    expect(urlHostMatches("https://example.com/", "commoncrawl.org")).toBe(false);
  });

  it("rejects a tail-collision attack like `evilcommoncrawl.org`", () => {
    // The naive `endsWith("commoncrawl.org")` check would accept this;
    // requiring a leading dot means only true sub-domains pass.
    expect(urlHostMatches("https://evilcommoncrawl.org/", "commoncrawl.org")).toBe(false);
  });

  it("returns false for a malformed URL", () => {
    expect(urlHostMatches("garbage", "commoncrawl.org")).toBe(false);
  });
});
