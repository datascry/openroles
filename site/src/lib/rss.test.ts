import { describe, expect, it } from "bun:test";
import { type Job, jobId } from "@openroles/shared";
import fc from "fast-check";
import { FEED_ITEM_CAP, freshJobs, renderFeed, toRfc822 } from "./rss.ts";

const OBSERVED_AT = "2026-04-26T00:00:00Z";

function makeJob(overrides: Partial<Job> = {}): Job {
  const base = {
    ats: "greenhouse" as const,
    tenant_slug: "stripe",
    source_id: "1",
    title: "Senior Software Engineer",
    company: "Stripe",
    url: "https://example.com/1",
  };
  const m = { ...base, ...overrides };
  return {
    id: jobId({ ats: m.ats, tenant_slug: m.tenant_slug, source_id: m.source_id, url: m.url }),
    ats: m.ats,
    tenant_slug: m.tenant_slug,
    source_id: m.source_id,
    title: m.title,
    company: m.company,
    level: null,
    level_rank: null,
    workplace_type: null,
    is_recruiter_post: false,
    first_seen_at: OBSERVED_AT,
    last_seen_at: OBSERVED_AT,
    url: m.url,
    ...overrides,
  };
}

const channel = {
  title: "openroles — all jobs",
  link: "https://datascry.github.io/openroles",
  description: "Latest jobs across the index",
  selfUrl: "https://datascry.github.io/openroles/feed.xml",
  lastBuildDate: OBSERVED_AT,
};

describe("toRfc822", () => {
  it("converts ISO 8601 UTC to RFC 822", () => {
    expect(toRfc822("2026-04-26T00:00:00Z")).toBe("Sun, 26 Apr 2026 00:00:00 GMT");
  });

  it("throws on invalid input", () => {
    expect(() => toRfc822("not a date")).toThrow();
  });
});

describe("freshJobs", () => {
  it("excludes posts older than 90 days from posted_at", () => {
    const now = new Date("2026-04-26T00:00:00Z");
    const fresh = freshJobs(
      [
        makeJob({
          source_id: "1",
          url: "https://example.com/1",
          posted_at: "2026-04-20T00:00:00Z",
        }),
        makeJob({
          source_id: "2",
          url: "https://example.com/2",
          posted_at: "2025-01-01T00:00:00Z",
        }),
      ],
      now,
    );
    expect(fresh).toHaveLength(1);
    expect(fresh[0]?.source_id).toBe("1");
  });

  it("falls back to first_seen_at when posted_at is missing", () => {
    const now = new Date("2026-04-26T00:00:00Z");
    const fresh = freshJobs(
      [
        makeJob({
          source_id: "1",
          url: "https://example.com/1",
          first_seen_at: "2026-04-22T00:00:00Z",
        }),
        makeJob({
          source_id: "2",
          url: "https://example.com/2",
          first_seen_at: "2024-01-01T00:00:00Z",
        }),
      ],
      now,
    );
    expect(fresh).toHaveLength(1);
  });

  it("sorts by posted_at DESC, breaking ties on first_seen_at then id", () => {
    const now = new Date("2026-04-26T00:00:00Z");
    const fresh = freshJobs(
      [
        makeJob({
          source_id: "1",
          url: "https://example.com/1",
          posted_at: "2026-04-22T00:00:00Z",
          first_seen_at: "2026-04-22T00:00:00Z",
        }),
        makeJob({
          source_id: "2",
          url: "https://example.com/2",
          posted_at: "2026-04-25T00:00:00Z",
          first_seen_at: "2026-04-25T00:00:00Z",
        }),
        makeJob({
          source_id: "3",
          url: "https://example.com/3",
          posted_at: "2026-04-25T00:00:00Z",
          first_seen_at: "2026-04-23T00:00:00Z",
        }),
      ],
      now,
    );
    expect(fresh.map((j) => j.source_id)).toEqual(["2", "3", "1"]);
  });

  it("caps the output at 100 items", () => {
    const now = new Date("2026-04-26T00:00:00Z");
    const fresh = freshJobs(
      Array.from({ length: 200 }, (_, i) =>
        makeJob({
          source_id: String(i),
          url: `https://example.com/${i}`,
          posted_at: "2026-04-20T00:00:00Z",
        }),
      ),
      now,
    );
    expect(fresh).toHaveLength(FEED_ITEM_CAP);
  });
});

describe("renderFeed", () => {
  it("renders a valid-looking RSS 2.0 envelope with zero items", () => {
    const xml = renderFeed(channel, []);
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain('<rss version="2.0"');
    expect(xml).toContain("<ttl>1440</ttl>");
    expect(xml).not.toContain("<item>");
  });

  it("escapes XML metacharacters in titles, companies, and urls", () => {
    const xml = renderFeed(channel, [
      makeJob({
        title: "Engineer & Hacker <Senior>",
        company: '"Acme"',
        url: "https://example.com/?a=1&b=2",
      }),
    ]);
    expect(xml).toContain("Engineer &amp; Hacker &lt;Senior&gt;");
    expect(xml).toContain("&quot;Acme&quot;");
    expect(xml).toContain("a=1&amp;b=2");
  });

  it("wraps description in CDATA and escapes ]]> sequences", () => {
    const xml = renderFeed(channel, [
      makeJob({ description_excerpt: "ends with ]]> hostile string" }),
    ]);
    expect(xml).toContain("<![CDATA[");
    expect(xml).not.toMatch(/\]\]>\s*hostile/);
  });

  it("emits one <category> for ATS plus optional level", () => {
    const xml = renderFeed(channel, [
      makeJob({ ats: "greenhouse", level: "senior", level_rank: 4 }),
    ]);
    expect(xml.match(/<category>/g)?.length).toBe(2);
    expect(xml).toContain("<category>greenhouse</category>");
    expect(xml).toContain("<category>senior</category>");
  });

  it("uses posted_at when present and first_seen_at as fallback for pubDate", () => {
    const xml = renderFeed(channel, [
      makeJob({ posted_at: "2026-04-22T17:14:00Z" }),
      makeJob({
        source_id: "2",
        url: "https://example.com/2",
        first_seen_at: "2026-04-23T00:00:00Z",
      }),
    ]);
    expect(xml).toContain("<pubDate>Wed, 22 Apr 2026 17:14:00 GMT</pubDate>");
    expect(xml).toContain("<pubDate>Thu, 23 Apr 2026 00:00:00 GMT</pubDate>");
  });

  it("renders an item title in 'Title — Company' shape", () => {
    const xml = renderFeed(channel, [makeJob({ title: "Senior Engineer", company: "Stripe" })]);
    expect(xml).toContain("<title>Senior Engineer — Stripe</title>");
  });

  it("any subset of valid Jobs renders well-formed XML (property)", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            t: fc
              .string({ minLength: 1, maxLength: 32 })
              .map((s) => s.replace(/[<>&"]/g, "x") || "x"),
            c: fc
              .string({ minLength: 1, maxLength: 24 })
              .map((s) => s.replace(/[<>&"]/g, "x") || "x"),
            sid: fc.string({ minLength: 1, maxLength: 8 }).filter((s) => /^[a-z0-9-]+$/i.test(s)),
          }),
          { maxLength: 8 },
        ),
        (rows) => {
          const jobs = rows.map((r, i) =>
            makeJob({
              source_id: r.sid + String(i),
              url: `https://example.com/${i}`,
              title: r.t,
              company: r.c,
            }),
          );
          const xml = renderFeed(channel, jobs);
          return (
            xml.startsWith("<?xml") &&
            xml.includes("<rss") &&
            xml.endsWith("</rss>\n") &&
            (xml.match(/<item>/g)?.length ?? 0) === jobs.length
          );
        },
      ),
      { numRuns: 30 },
    );
  });
});
