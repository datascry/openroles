import { describe, expect, it } from "bun:test";
import { excerpt, normalizeWorkplace, plainText, splitLocation } from "./normalize.ts";

describe("plainText", () => {
  it("strips HTML tags and decodes entities", () => {
    expect(plainText("<p>Hello&nbsp;world &amp; more</p>")).toBe("Hello world & more");
  });

  it("collapses whitespace runs", () => {
    expect(plainText("a\n\n  b\t c")).toBe("a b c");
  });

  it("returns empty string for empty / undefined", () => {
    expect(plainText("")).toBe("");
    expect(plainText(undefined)).toBe("");
  });

  it("decodes numeric entities", () => {
    expect(plainText("&#x2014; &#8212;")).toBe("— —");
  });

  it("removes script/style tag contents", () => {
    expect(plainText("<script>alert('x')</script>hi")).toBe("hi");
    expect(plainText("<style>body{}</style>hi")).toBe("hi");
  });
});

describe("excerpt", () => {
  it("trims to ~280 chars on a word boundary", () => {
    const long = "abcdefg ".repeat(80);
    const e = excerpt(long);
    expect(e.length).toBeLessThanOrEqual(280);
    expect(e.endsWith(" ")).toBe(false);
  });

  it("returns the body unchanged when short", () => {
    expect(excerpt("short body")).toBe("short body");
  });

  it("returns empty for empty input", () => {
    expect(excerpt("")).toBe("");
  });
});

describe("splitLocation", () => {
  it("parses common 'City, State' shape", () => {
    expect(splitLocation("San Francisco, CA")).toEqual({
      text: "San Francisco, CA",
      country: undefined,
      region: "CA",
    });
  });

  it("parses 'City, State, US'", () => {
    expect(splitLocation("Austin, TX, US")).toEqual({
      text: "Austin, TX, US",
      country: "US",
      region: "TX",
    });
  });

  it("returns text-only for free-form values", () => {
    expect(splitLocation("Anywhere")).toEqual({
      text: "Anywhere",
      country: undefined,
      region: undefined,
    });
  });

  it("returns undefined country/region for empty", () => {
    expect(splitLocation("")).toEqual({
      text: "",
      country: undefined,
      region: undefined,
    });
  });
});

describe("normalizeWorkplace", () => {
  it("maps known synonyms to canonical types", () => {
    expect(normalizeWorkplace("Remote")).toBe("remote");
    expect(normalizeWorkplace("Hybrid Work")).toBe("hybrid");
    expect(normalizeWorkplace("On-site")).toBe("onsite");
    expect(normalizeWorkplace("In Office")).toBe("onsite");
  });

  it("returns null for unknown input", () => {
    expect(normalizeWorkplace("flexible")).toBeNull();
    expect(normalizeWorkplace(undefined)).toBeNull();
  });
});
