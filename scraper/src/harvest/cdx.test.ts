import { describe, expect, it } from "bun:test";
import {
  buildCdxUrl,
  type CdxRecord,
  extractSlugs,
  harvestPlanFor,
  parseCdxJsonLines,
} from "./cdx.ts";
import { harvestPatternFor } from "./patterns.ts";

describe("parseCdxJsonLines", () => {
  it("returns one record per JSON line", () => {
    const body = [
      '{"url":"https://boards.greenhouse.io/stripe","status":"200","timestamp":"20260101000000"}',
      '{"url":"https://boards.greenhouse.io/anthropic","status":"200","timestamp":"20260101000000"}',
      "",
    ].join("\n");
    expect(parseCdxJsonLines(body)).toHaveLength(2);
  });

  it("skips malformed lines instead of throwing", () => {
    const body = ['{"url":"https://x/y","status":"200","timestamp":"2026"}', "{not json", ""].join(
      "\n",
    );
    expect(parseCdxJsonLines(body)).toHaveLength(1);
  });

  it("skips records with non-string url", () => {
    const body = ['{"url":123,"status":"200"}', '{"url":"https://x"}', ""].join("\n");
    expect(parseCdxJsonLines(body)).toHaveLength(1);
  });

  it("skips JSON arrays / non-objects", () => {
    const body = ["[1,2,3]", "null", '"hello"', '{"url":"https://x"}'].join("\n");
    expect(parseCdxJsonLines(body)).toHaveLength(1);
  });

  it("returns [] on empty body", () => {
    expect(parseCdxJsonLines("")).toEqual([]);
  });

  it("handles \\r\\n line endings", () => {
    const body = '{"url":"https://x","status":"200"}\r\n{"url":"https://y","status":"200"}\r\n';
    expect(parseCdxJsonLines(body)).toHaveLength(2);
  });
});

describe("extractSlugs", () => {
  const records: CdxRecord[] = [
    { url: "https://boards.greenhouse.io/stripe/jobs/1", status: "200", timestamp: "" },
    { url: "https://boards.greenhouse.io/anthropic", status: "200", timestamp: "" },
    { url: "https://boards.greenhouse.io/stripe/jobs/2", status: "200", timestamp: "" },
    { url: "https://boards.greenhouse.io/embed/job_app?for=evil", status: "200", timestamp: "" },
    { url: "https://example.com/unrelated", status: "200", timestamp: "" },
  ];

  it("dedupes slugs and extracts both /{slug} and /embed/job_app?for={slug} forms", () => {
    const { slugs } = extractSlugs(records, harvestPatternFor("greenhouse"));
    expect(slugs).toEqual(["anthropic", "evil", "stripe"]);
  });

  it("returns the ats id from the pattern", () => {
    const { ats } = extractSlugs([], harvestPatternFor("lever"));
    expect(ats).toBe("lever");
  });

  it("returns empty when no records match", () => {
    const { slugs } = extractSlugs(
      [{ url: "https://elsewhere.com/foo", status: "", timestamp: "" }],
      harvestPatternFor("greenhouse"),
    );
    expect(slugs).toEqual([]);
  });

  it("preserves stable iteration order despite shared regex state", () => {
    const pattern = harvestPatternFor("greenhouse");
    const a = extractSlugs(records, pattern).slugs;
    const b = extractSlugs(records, pattern).slugs;
    expect(a).toEqual(b);
  });
});

describe("buildCdxUrl", () => {
  it("targets the CC-MAIN-{snapshot}-index endpoint with required params", () => {
    const url = buildCdxUrl("2026-13", "boards.greenhouse.io/*");
    expect(url).toContain("https://index.commoncrawl.org/CC-MAIN-2026-13-index?");
    expect(url).toContain("url=boards.greenhouse.io%2F*");
    expect(url).toContain("output=json");
    expect(url).toContain("page=0");
  });

  it("supports paginated requests", () => {
    expect(buildCdxUrl("2026-13", "x", 7)).toContain("page=7");
  });
});

describe("harvestPlanFor", () => {
  it("emits one CDX URL per snapshot", () => {
    const { urls } = harvestPlanFor("greenhouse", ["2026-13", "2025-50", "2025-39", "2025-26"]);
    expect(urls).toHaveLength(4);
    expect(urls[0]).toContain("CC-MAIN-2026-13-index");
  });
});
