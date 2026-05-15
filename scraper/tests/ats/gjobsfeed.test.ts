import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import fc from "fast-check";
import { parseGjobsfeed, scrapeGjobsfeedTenant } from "../../src/ats/gjobsfeed.ts";
import { HttpClient } from "../../src/http.ts";
import { RobotsTxtCache } from "../../src/robots.ts";
import {
  clientWithRobotsAllowAll,
  HttpResponse,
  http,
  makeServer,
  readFixtureText,
} from "../helpers.ts";

const OBSERVED_AT = "2026-05-15T00:00:00Z";
const FEED_URL = "https://jobs.example.com/sitemap.xml";

const server = makeServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("parseGjobsfeed (fixture replay)", () => {
  it("parses the real SAP feed (3 trimmed items)", () => {
    const xml = readFixtureText("gjobsfeed.sap-real.xml");
    const jobs = parseGjobsfeed({
      tenant: { slug: "sap", display_name: "SAP" },
      company: "SAP",
      xml,
      observedAt: OBSERVED_AT,
    });
    expect(jobs).toHaveLength(3);
    const intern = jobs.find((j) => j.title.includes("SAP iXp Intern"));
    expect(intern).toBeDefined();
    expect(intern?.company).toBe("SAP");
    expect(intern?.ats).toBe("gjobsfeed");
    expect(intern?.tenant_slug).toBe("sap");
    // g:id is the numeric job id; coerced to string source_id.
    expect(intern?.source_id).toMatch(/^\d+$/);
    expect(intern?.url.startsWith("https://jobs.sap.com/job/")).toBe(true);
    // description_excerpt is derived from the CDATA HTML by buildJob.
    expect(intern?.description_excerpt && intern.description_excerpt.length > 0).toBe(true);
  });

  it("parses the real ExxonMobil feed (3 trimmed items) with location + department", () => {
    const xml = readFixtureText("gjobsfeed.exxonmobil-real.xml");
    const jobs = parseGjobsfeed({
      tenant: { slug: "exxonmobil", display_name: "ExxonMobil" },
      company: "ExxonMobil",
      xml,
      observedAt: OBSERVED_AT,
    });
    expect(jobs).toHaveLength(3);
    const lead = jobs.find((j) => j.title.includes("Lead Power Quantitative Risk Modeler"));
    expect(lead?.source_id).toBe("1367059400");
    expect(lead?.location_text).toBe("London, LND, GB");
    expect(lead?.department).toBe("Finance, accounting and tax");
    expect(lead?.url).toBe(
      "https://jobs.exxonmobil.com/ExxonMobil/job/London-2026UKH-Lead-Power-Quantitative-Risk-Modeler-LND/1367059400/",
    );
    // The Google feed has no post date — posted_at must be absent.
    expect(lead?.posted_at).toBeUndefined();
  });

  it("handles edge items: guid fallback, missing title/ids dropped, dedupe", () => {
    const xml = readFixtureText("gjobsfeed.edge.xml");
    const jobs = parseGjobsfeed({
      tenant: { slug: "edge", display_name: "Edge Co" },
      company: "Edge Co",
      xml,
      observedAt: OBSERVED_AT,
    });
    // 5 items in the fixture:
    //  - 9001: no g:id, falls back to guid -> kept
    //  - no title -> dropped
    //  - no link + no ids -> dropped
    //  - 9003: g:id, no description/function -> kept
    //  - duplicate of 9001 (same id+url) -> deduped
    expect(jobs).toHaveLength(2);
    const a = jobs.find((j) => j.source_id === "9001");
    expect(a?.title).toBe("Has guid but no g:id");
    expect(a?.location_text).toBe("Austin, TX, US");
    const b = jobs.find((j) => j.source_id === "9003");
    expect(b?.title).toBe("Has g:id, no description, no function");
    expect(b?.department).toBeUndefined();
    expect(b?.description_excerpt).toBeUndefined();
  });

  it("returns [] on malformed XML, non-RSS, and empty channel — never throws", () => {
    for (const xml of [
      "not xml at all",
      "<?xml version='1.0'?><other/>",
      "<rss><channel></channel></rss>",
      "<rss version='2.0'><channel><title>x</title></channel></rss>",
      "",
    ]) {
      expect(
        parseGjobsfeed({
          tenant: { slug: "x" },
          company: "X",
          xml,
          observedAt: OBSERVED_AT,
        }),
      ).toEqual([]);
    }
  });

  it("accepts a single-item channel (object, not array)", () => {
    const xml =
      "<rss version='2.0' xmlns:g='http://base.google.com/ns/1.0'><channel><title>One</title>" +
      "<item><title>Only Role</title><link>https://jobs.example.com/job/1/</link>" +
      "<g:id>1</g:id><g:location>NYC, NY, US</g:location></item></channel></rss>";
    const jobs = parseGjobsfeed({
      tenant: { slug: "one", display_name: "One" },
      company: "One",
      xml,
      observedAt: OBSERVED_AT,
    });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.source_id).toBe("1");
  });
});

describe("parseGjobsfeed (property)", () => {
  const safeSlug = fc.stringMatching(/^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$/);

  it("is deterministic on the same feed for any safe slug", () => {
    const xml = readFixtureText("gjobsfeed.sap-real.xml");
    fc.assert(
      fc.property(safeSlug, (slug) => {
        const a = parseGjobsfeed({ tenant: { slug }, company: slug, xml, observedAt: OBSERVED_AT });
        const b = parseGjobsfeed({ tenant: { slug }, company: slug, xml, observedAt: OBSERVED_AT });
        return JSON.stringify(a) === JSON.stringify(b);
      }),
      { numRuns: 40 },
    );
  });

  it("never throws on arbitrary input", () => {
    fc.assert(
      fc.property(fc.string(), (xml) => {
        parseGjobsfeed({ tenant: { slug: "x" }, company: "X", xml, observedAt: OBSERVED_AT });
        return true;
      }),
      { numRuns: 60 },
    );
  });
});

describe("scrapeGjobsfeedTenant", () => {
  it("fetches the feed and returns success with parsed jobs", async () => {
    server.use(
      http.get(FEED_URL, () => HttpResponse.xml(readFixtureText("gjobsfeed.exxonmobil-real.xml"))),
    );
    const out = await scrapeGjobsfeedTenant({
      tenant: { slug: "exxonmobil", display_name: "ExxonMobil" },
      client: clientWithRobotsAllowAll(),
      observedAt: OBSERVED_AT,
      feedUrl: FEED_URL,
    });
    expect(out.result.status).toBe("success");
    expect(out.result.jobs_count).toBe(3);
    expect(out.jobs).toHaveLength(3);
  });

  it("marks transient_failure when the feed parses to zero jobs", async () => {
    server.use(
      http.get(FEED_URL, () =>
        HttpResponse.xml("<rss version='2.0'><channel><title>empty</title></channel></rss>"),
      ),
    );
    const out = await scrapeGjobsfeedTenant({
      tenant: { slug: "empty" },
      client: clientWithRobotsAllowAll(),
      observedAt: OBSERVED_AT,
      feedUrl: FEED_URL,
    });
    expect(out.jobs).toHaveLength(0);
    expect(out.result.status).toBe("transient_failure");
  });

  it("returns dead on an invalid feed_url", async () => {
    const out = await scrapeGjobsfeedTenant({
      tenant: { slug: "x" },
      client: clientWithRobotsAllowAll(),
      observedAt: OBSERVED_AT,
      feedUrl: "not-a-url",
    });
    expect(out.result.status).toBe("dead");
    expect(out.result.error).toContain("invalid feed_url");
  });

  it("rejects unsafe feed_url hosts at the scrape boundary (SSRF guard)", async () => {
    for (const feedUrl of [
      "http://jobs.example.com/sitemap.xml",
      "https://localhost/feed.xml",
      "https://feed.local/x.xml",
      "https://feed.internal/x.xml",
      "https://192.168.1.1/feed.xml",
      "https://10.0.0.1/feed.xml",
      "https://169.254.169.254/feed.xml",
      "https://172.16.0.1/feed.xml",
      "https://metadata.google.internal/feed.xml",
    ]) {
      const out = await scrapeGjobsfeedTenant({
        tenant: { slug: "x" },
        client: clientWithRobotsAllowAll(),
        observedAt: OBSERVED_AT,
        feedUrl,
      });
      expect(out.jobs).toHaveLength(0);
      expect(out.result.status).toBe("dead");
      expect(out.result.error).toContain("unsafe feed_url host");
    }
  });

  it("rejects unsafe slugs at the dispatcher boundary", async () => {
    const out = await scrapeGjobsfeedTenant({
      tenant: { slug: "../etc/passwd" },
      client: clientWithRobotsAllowAll(),
      observedAt: OBSERVED_AT,
      feedUrl: FEED_URL,
    });
    expect(out.jobs).toHaveLength(0);
    expect(out.result.status).toBe("dead");
  });

  it("surfaces a transient_failure when robots.txt disallows the feed", async () => {
    const robotsFetch = async () => new Response("User-agent: *\nDisallow: /\n", { status: 200 });
    const robots = new RobotsTxtCache({ fetchFn: robotsFetch, clock: () => 0 });
    const client = new HttpClient({
      userAgent: "openroles/0.0.0 (+https://example.com/contact)",
      robots,
      sleep: async () => {},
      random: () => 0.5,
      retry: { maxAttempts: 1, baseMs: 1, maxMs: 1 },
    });
    const out = await scrapeGjobsfeedTenant({
      tenant: { slug: "blocked" },
      client,
      observedAt: OBSERVED_AT,
      feedUrl: FEED_URL,
    });
    expect(out.jobs).toHaveLength(0);
    // robots disallow throws inside client.request → errorToResult.
    expect(["transient_failure", "dead"]).toContain(out.result.status);
  });
});
