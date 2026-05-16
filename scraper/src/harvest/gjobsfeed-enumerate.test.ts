import { describe, expect, it } from "bun:test";
import {
  buildEnumerationSql,
  deriveSlug,
  type GjobsfeedCandidate,
  mergeCandidates,
  parseDuckdbHostRows,
} from "./gjobsfeed-enumerate.ts";

describe("deriveSlug", () => {
  it("strips a career prefix and the public suffix", () => {
    expect(deriveSlug("jobs.sap.com")).toBe("sap");
    expect(deriveSlug("careers.molsoncoors.com")).toBe("molsoncoors");
    expect(deriveSlug("recruiting.bigco.io")).toBe("bigco");
    expect(deriveSlug("talent.foo.org")).toBe("foo");
  });

  it("handles two-label public suffixes", () => {
    expect(deriveSlug("jobs.foo.co.uk")).toBe("foo");
    expect(deriveSlug("careers.acme.com.au")).toBe("acme");
    expect(deriveSlug("jobs.brand.co.jp")).toBe("brand");
  });

  it("derives from a host with no career prefix", () => {
    expect(deriveSlug("workday.example.com")).toBe("example");
    expect(deriveSlug("brand.com")).toBe("brand");
  });

  it("is case-insensitive and trims", () => {
    expect(deriveSlug("  JOBS.SAP.COM ")).toBe("sap");
  });

  it("rejects malformed / IP / suffix-only hosts", () => {
    expect(deriveSlug("")).toBeNull();
    expect(deriveSlug("nodot")).toBeNull();
    expect(deriveSlug("jobs.com")).toBeNull(); // prefix + suffix only, no registrable label
    expect(deriveSlug("169.254.169.254")).toBeNull();
    expect(deriveSlug("[::1]")).toBeNull();
    expect(deriveSlug("jobs.sap.com:443")).toBeNull();
    expect(deriveSlug("jobs..sap.com")).toBeNull(); // double dot
    expect(deriveSlug(".jobs.sap.com")).toBeNull(); // leading dot
    expect(deriveSlug("jobs.s ap.com")).toBeNull(); // space → invalid char
    expect(deriveSlug("co.uk")).toBeNull(); // suffix only
  });

  it("rejects a derived slug that fails SLUG_PATTERN", () => {
    // SLUG_PATTERN allows max 64 chars (1 + 62 + 1); 65 exceeds it.
    const long = "a".repeat(65);
    expect(deriveSlug(`jobs.${long}.com`)).toBeNull();
    // A label with an invalid char also fails the pattern.
    expect(deriveSlug("jobs.foo_bar.com")).toBeNull();
  });
});

describe("parseDuckdbHostRows", () => {
  it("drops the header, trims, unquotes, ignores blanks and CRLF", () => {
    const out = parseDuckdbHostRows(
      'url_host_name\r\n"jobs.sap.com"\r\ncareers.acme.com\n\n  jobs.foo.co.uk  \n',
    );
    expect(out).toEqual(["jobs.sap.com", "careers.acme.com", "jobs.foo.co.uk"]);
  });

  it("returns [] on empty or header-only input", () => {
    expect(parseDuckdbHostRows("")).toEqual([]);
    expect(parseDuckdbHostRows("url_host_name\n")).toEqual([]);
  });

  it("keeps a first row that is not the header", () => {
    expect(parseDuckdbHostRows("jobs.sap.com\ncareers.x.com")).toEqual([
      "jobs.sap.com",
      "careers.x.com",
    ]);
  });
});

describe("mergeCandidates", () => {
  const existing: GjobsfeedCandidate[] = [
    { slug: "sap", display_name: "SAP", hosts: ["jobs.sap.com"] },
  ];

  it("adds new slugs, titleises display_name, preserves existing", () => {
    const r = mergeCandidates(existing, ["careers.molsoncoors.com", "jobs.boston-sci.com"]);
    expect(r.added).toBe(2);
    expect(r.candidates.map((c) => c.slug)).toEqual(["boston-sci", "molsoncoors", "sap"]);
    const mc = r.candidates.find((c) => c.slug === "molsoncoors");
    expect(mc?.display_name).toBe("Molsoncoors");
    expect(mc?.hosts).toEqual(["careers.molsoncoors.com"]);
    const bs = r.candidates.find((c) => c.slug === "boston-sci");
    expect(bs?.display_name).toBe("Boston Sci");
    // existing SAP untouched
    expect(r.candidates.find((c) => c.slug === "sap")?.display_name).toBe("SAP");
  });

  it("unions a new host into an existing slug without touching display_name", () => {
    const r = mergeCandidates(existing, ["careers.sap.com"]);
    expect(r.added).toBe(0);
    expect(r.hostsAddedToExisting).toBe(1);
    const sap = r.candidates.find((c) => c.slug === "sap");
    expect(sap?.hosts).toEqual(["careers.sap.com", "jobs.sap.com"]);
    expect(sap?.display_name).toBe("SAP");
  });

  it("is idempotent: re-merging the same host is a no-op", () => {
    const r = mergeCandidates(existing, ["jobs.sap.com"]);
    expect(r.added).toBe(0);
    expect(r.hostsAddedToExisting).toBe(0);
    expect(r.candidates).toEqual(existing);
  });

  it("counts and skips unparseable hosts", () => {
    const r = mergeCandidates([], ["jobs.good.com", "169.254.169.254", "nodot", ""]);
    expect(r.added).toBe(1);
    expect(r.skipped).toBe(3);
    expect(r.candidates.map((c) => c.slug)).toEqual(["good"]);
  });
});

describe("buildEnumerationSql", () => {
  it("embeds the validated crawl id and the CC parquet location", () => {
    const sql = buildEnumerationSql("CC-MAIN-2026-17");
    expect(sql).toContain(
      "s3://commoncrawl/cc-index/table/cc-main/warc/crawl=CC-MAIN-2026-17/subset=warc/*.parquet",
    );
    expect(sql).toContain("url_path = '/sitemap.xml'");
    expect(sql).toContain("fetch_status = 200");
    expect(sql).toContain("INSTALL httpfs");
  });

  it("rejects an invalid crawl id (injection guard)", () => {
    expect(() => buildEnumerationSql("CC-MAIN-2026-17'; DROP TABLE x;--")).toThrow("invalid crawl");
    expect(() => buildEnumerationSql("latest")).toThrow("invalid crawl");
    expect(() => buildEnumerationSql("")).toThrow("invalid crawl");
  });
});
