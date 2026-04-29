import { describe, expect, it } from "bun:test";
import {
  buildCdxNumPagesUrl,
  buildCdxUrl,
  type CdxRecord,
  extractSlugs,
  harvestPlanFor,
  parseCdxJsonLines,
  parseNumPages,
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
    // /embed/* is filtered by the deny list (greenhouse robots disallow that
    // path so it never appears in real CDX records, but a stray URL must
    // still be rejected for safety).
    { url: "https://boards.greenhouse.io/embed/job_app?for=evil", status: "200", timestamp: "" },
    { url: "https://example.com/unrelated", status: "200", timestamp: "" },
  ];

  it("dedupes slugs from the canonical /{slug} URL form and applies the deny list", () => {
    const { slugs } = extractSlugs(records, harvestPatternFor("greenhouse"));
    // `embed` is captured by the path regex but filtered by PATH_DENY; the
    // `evil` segment is not extracted because the regex stops at the first
    // path component (no second iteration through `embed/job_app`).
    expect(slugs).toEqual(["anthropic", "stripe"]);
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

  it("captures workday composite metadata (host + site) from the user-facing /{Site} URL", () => {
    const r: CdxRecord[] = [
      // User-facing path — site captured as the trailing capitalized segment.
      {
        url: "https://example.wd5.myworkdayjobs.com/Careers",
        status: "200",
        timestamp: "",
      },
      // API path same tenant later — first-seen-wins keeps the original.
      {
        url: "https://example.wd5.myworkdayjobs.com/wday/cxs/example/External/jobs",
        status: "200",
        timestamp: "",
      },
    ];
    const { slugs, metadata } = extractSlugs(r, harvestPatternFor("workday"));
    expect(slugs).toEqual(["example"]);
    expect(metadata.get("example")).toEqual({
      host: "example.wd5.myworkdayjobs.com",
      site: "Careers",
    });
  });

  it("captures workday host-only when the URL is a bare host with no site segment", () => {
    const r: CdxRecord[] = [
      {
        url: "https://example.wd5.myworkdayjobs.com/",
        status: "200",
        timestamp: "",
      },
    ];
    const { slugs, metadata } = extractSlugs(r, harvestPatternFor("workday"));
    expect(slugs).toEqual(["example"]);
    expect(metadata.get("example")).toEqual({ host: "example.wd5.myworkdayjobs.com" });
  });

  it("ignores nested workday paths whose first segment is lowercase (job listings, not site codes)", () => {
    const r: CdxRecord[] = [
      // `/job/123` after a real tenant URL would have been captured as
      // site "job" if the i-flag pollution wasn't fixed; `[A-Z]` is now
      // strictly uppercase.
      {
        url: "https://example.wd5.myworkdayjobs.com/job/12345-engineer",
        status: "200",
        timestamp: "",
      },
    ];
    const { metadata } = extractSlugs(r, harvestPatternFor("workday"));
    // Slug captured but site not — `job` doesn't match `[A-Z][A-Za-z0-9_-]*`.
    expect(metadata.get("example")).toEqual({ host: "example.wd5.myworkdayjobs.com" });
  });

  it("captures workday site code when the API URL is seen first", () => {
    const r: CdxRecord[] = [
      {
        url: "https://acme.wd103.myworkdayjobs.com/wday/cxs/acme/Engineering/jobs?limit=20",
        status: "200",
        timestamp: "",
      },
    ];
    const { slugs, metadata } = extractSlugs(r, harvestPatternFor("workday"));
    expect(slugs).toEqual(["acme"]);
    expect(metadata.get("acme")).toEqual({
      host: "acme.wd103.myworkdayjobs.com",
      site: "Engineering",
    });
  });

  it("captures ultipro board_id from the JobBoard path", () => {
    const r: CdxRecord[] = [
      // Bare landing — slug only, no metadata.
      { url: "https://recruiting.ultipro.com/abc1002awcn", status: "200", timestamp: "" },
      // Job board path — guid captured.
      {
        url: "https://recruiting.ultipro.com/abc1002awcn/JobBoard/12345678-1234-1234-1234-123456789012/Search",
        status: "200",
        timestamp: "",
      },
      // Different tenant with no guid.
      { url: "https://recruiting.ultipro.com/xyz9999/Login", status: "200", timestamp: "" },
    ];
    const { slugs, metadata } = extractSlugs(r, harvestPatternFor("ultipro"));
    expect(slugs).toEqual(["abc1002awcn", "xyz9999"]);
    // First-*non-empty*-metadata wins: the bare landing extracts no
    // metadata so the JobBoard record (later) gets to set it. xyz9999
    // never has a JobBoard URL, so its metadata stays empty.
    expect(metadata.get("abc1002awcn")).toEqual({
      board_id: "12345678-1234-1234-1234-123456789012",
    });
    expect(metadata.has("xyz9999")).toBe(false);
  });

  it("captures ultipro board_id when the JobBoard URL is seen first", () => {
    const r: CdxRecord[] = [
      {
        url: "https://recruiting.ultipro.com/aal1000aipsa/JobBoard/abcdef12-3456-7890-abcd-ef1234567890/Search",
        status: "200",
        timestamp: "",
      },
    ];
    const { slugs, metadata } = extractSlugs(r, harvestPatternFor("ultipro"));
    expect(slugs).toEqual(["aal1000aipsa"]);
    expect(metadata.get("aal1000aipsa")).toEqual({
      board_id: "abcdef12-3456-7890-abcd-ef1234567890",
    });
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

describe("buildCdxNumPagesUrl", () => {
  it("targets the same index endpoint with showNumPages=true", () => {
    const url = buildCdxNumPagesUrl("2026-13", "*.greenhouse.io/*");
    expect(url).toContain("CC-MAIN-2026-13-index");
    expect(url).toContain("showNumPages=true");
    expect(url).toContain(`url=${encodeURIComponent("*.greenhouse.io/*")}`);
  });
});

describe("parseNumPages", () => {
  it("reads the bare integer form CDX returns", () => {
    expect(parseNumPages("12")).toBe(12);
    expect(parseNumPages("0")).toBe(0);
    expect(parseNumPages("  7\n")).toBe(7);
  });

  it("reads the {pages: N} JSON form CDX sometimes returns", () => {
    expect(parseNumPages('{"pages": 4}')).toBe(4);
    expect(parseNumPages('{"pages": 0, "blocks": 1}')).toBe(0);
  });

  it("returns 0 when JSON parses but lacks a numeric pages field", () => {
    expect(parseNumPages('{"pages": "many"}')).toBe(0);
    expect(parseNumPages('{"blocks": 4}')).toBe(0);
    expect(parseNumPages('{"pages": -1}')).toBe(0);
  });

  it("returns 0 on malformed input rather than throwing", () => {
    expect(parseNumPages("not a number")).toBe(0);
    expect(parseNumPages("{not json")).toBe(0);
    expect(parseNumPages("[1,2,3]")).toBe(0);
    expect(parseNumPages("null")).toBe(0);
    expect(parseNumPages("")).toBe(0);
  });

  it("rejects negative integers (CDX never paginates backwards)", () => {
    expect(parseNumPages("-3")).toBe(0);
  });
});
