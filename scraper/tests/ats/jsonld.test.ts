import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import fc from "fast-check";
import {
  extractJobPostingJsonLd,
  isJsonldJobUrl,
  parseJsonldJobPage,
  parseJsonldSitemap,
  scrapeJsonldTenant,
} from "../../src/ats/jsonld.ts";
import {
  clientWithRobotsAllowAll,
  HttpResponse,
  http,
  makeServer,
  readFixtureText,
} from "../helpers.ts";

const OBSERVED_AT = "2026-05-14T00:00:00Z";
const SITEMAP_URL = "https://careers.example.com/sitemap.xml";
const EXPECTED_HOST = "careers.example.com";

const server = makeServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("parseJsonldSitemap", () => {
  it("parses a urlset and preserves loc + lastmod", () => {
    const xml = readFixtureText("jsonld.sitemap.small.xml");
    const urls = parseJsonldSitemap(xml);
    expect(urls).toHaveLength(4);
    expect(urls[0]?.loc).toBe("https://careers.example.com/job/1001-engineer");
    expect(urls[0]?.lastmod).toBe("2026-05-01");
    expect(urls[2]?.lastmod).toBeUndefined();
  });

  it("parses a sitemapindex with the same shape", () => {
    const xml = readFixtureText("jsonld.sitemap-index.xml");
    const urls = parseJsonldSitemap(xml);
    expect(urls).toHaveLength(2);
    expect(urls[0]?.loc).toBe("https://careers.example.com/sitemap-jobs-1.xml");
  });

  it("returns [] on non-XML input", () => {
    expect(parseJsonldSitemap("not xml")).toEqual([]);
  });

  it("returns [] on missing urlset root", () => {
    expect(parseJsonldSitemap("<?xml version='1.0'?><other/>")).toEqual([]);
  });
});

describe("extractJobPostingJsonLd", () => {
  it("extracts a JobPosting from a basic page", () => {
    const html = readFixtureText("jsonld.job-basic.html");
    const jl = extractJobPostingJsonLd(html);
    expect(jl?.title).toBe("Senior Software Engineer");
  });

  it("picks the JobPosting element from a JSON-LD array", () => {
    const html = readFixtureText("jsonld.edge-array-jsonld.html");
    const jl = extractJobPostingJsonLd(html);
    expect(jl?.title).toBe("Picked From Array");
  });

  it("returns null when no JSON-LD is present", () => {
    const html = readFixtureText("jsonld.edge-no-jsonld.html");
    expect(extractJobPostingJsonLd(html)).toBeNull();
  });

  it("returns null on malformed JSON-LD", () => {
    const html = readFixtureText("jsonld.edge-malformed.html");
    expect(extractJobPostingJsonLd(html)).toBeNull();
  });

  it("ignores a script with a non-ld+json type", () => {
    const html = `<html><head><script type="application/json">{"@type":"JobPosting","title":"Wrong type"}</script></head></html>`;
    expect(extractJobPostingJsonLd(html)).toBeNull();
  });
});

describe("parseJsonldJobPage (fixture replay)", () => {
  it("parses the basic fixture (US, ISO date, structured address)", () => {
    const html = readFixtureText("jsonld.job-basic.html");
    const job = parseJsonldJobPage({
      tenant: { slug: "example", display_name: "Example Co" },
      company: "Example Co",
      url: "https://careers.example.com/job/1001-engineer",
      html,
      observedAt: OBSERVED_AT,
    });
    expect(job?.title).toBe("Senior Software Engineer");
    expect(job?.ats).toBe("jsonld");
    expect(job?.source_id).toBe("REQ-1001");
    expect(job?.location_country).toBe("US");
    expect(job?.posted_at).toBe("2026-04-15T00:00:00Z");
    expect(job?.company).toBe("Example Co");
  });

  it("parses single-object jobLocation + PropertyValue identifier", () => {
    const html = readFixtureText("jsonld.job-remote.html");
    const job = parseJsonldJobPage({
      tenant: { slug: "example" },
      company: "Example Co",
      url: "https://careers.example.com/job/1002-designer",
      html,
      observedAt: OBSERVED_AT,
    });
    expect(job?.title).toBe("Senior Designer (Remote)");
    expect(job?.source_id).toBe("REQ-1002");
    expect(job?.workplace_type).toBe("remote");
    expect(job?.location_country).toBe("GB");
  });

  it("returns null when no JSON-LD is present", () => {
    expect(
      parseJsonldJobPage({
        tenant: { slug: "edge" },
        company: "Edge",
        url: "https://careers.example.com/job/none",
        html: readFixtureText("jsonld.edge-no-jsonld.html"),
        observedAt: OBSERVED_AT,
      }),
    ).toBeNull();
  });

  it("falls back to trailing-digit URL token for source_id", () => {
    const html = `<script type="application/ld+json">${JSON.stringify({
      "@type": "JobPosting",
      title: "Missing identifier",
      hiringOrganization: { name: "X" },
    })}</script>`;
    const job = parseJsonldJobPage({
      tenant: { slug: "x" },
      company: "X",
      url: "https://careers.x.com/job/austin/missing-identifier/9999",
      html,
      observedAt: OBSERVED_AT,
    });
    expect(job?.source_id).toBe("9999");
  });

  it("parses the real Spectrum fixture end-to-end", () => {
    const html = readFixtureText("jsonld.spectrum-real.html");
    const job = parseJsonldJobPage({
      tenant: { slug: "spectrum", display_name: "Spectrum" },
      company: "Spectrum",
      url: "https://jobs.spectrum.com/job/el-paso/customer-service-representative-technical-support-bilingual/4673/95063206736",
      html,
      observedAt: OBSERVED_AT,
    });
    // The Spectrum JSON-LD emits datePosted as "2026-5-13" — single-digit
    // month/day, which Date.parse() resolves to ISO. Verifies the
    // normalizer accepts the looser real-world variant.
    expect(job?.title).toBe("Customer Service Representative | Technical Support (Bilingual)");
    expect(job?.source_id).toBe("2026-74467");
    expect(job?.posted_at?.startsWith("2026-05-13")).toBe(true);
    // hiringOrganization.name on TalentBrew is the BU ("Customer Operations"),
    // NOT the brand. The adapter falls back to tenant.display_name.
    expect(job?.company).toBe("Spectrum");
    // addressCountry is "United States" (long form) — must not be misread
    // as an ISO-2 code.
    expect(job?.location_country).toBeUndefined();
    expect(job?.location_text).toContain("El Paso");
  });
});

describe("parseJsonldJobPage (property)", () => {
  // Use a unicode-friendly slug generator that still satisfies SLUG_PATTERN
  // — the parser must never throw for any slug that survives upstream
  // validation. The dispatcher applies assertSafeSlug, so this is the
  // shape of input we care about.
  const safeSlug = fc.stringMatching(/^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$/);

  it("is deterministic for any safe slug + valid URL", () => {
    const html = readFixtureText("jsonld.job-basic.html");
    fc.assert(
      fc.property(safeSlug, (slug) => {
        const a = parseJsonldJobPage({
          tenant: { slug },
          company: slug,
          url: "https://careers.example.com/job/1001-engineer",
          html,
          observedAt: OBSERVED_AT,
        });
        const b = parseJsonldJobPage({
          tenant: { slug },
          company: slug,
          url: "https://careers.example.com/job/1001-engineer",
          html,
          observedAt: OBSERVED_AT,
        });
        return JSON.stringify(a) === JSON.stringify(b);
      }),
      { numRuns: 50 },
    );
  });

  it("never throws on arbitrary HTML input", () => {
    // The extractor sits behind every job-page fetch in production;
    // a hostile or malformed page should result in `null`, never a
    // crash that kills the per-tenant Promise.all.
    fc.assert(
      fc.property(fc.string(), (html) => {
        const result = parseJsonldJobPage({
          tenant: { slug: "example" },
          company: "Example",
          url: "https://careers.example.com/job/1",
          html,
          observedAt: OBSERVED_AT,
        });
        return result === null || typeof result.id === "string";
      }),
      { numRuns: 100 },
    );
  });

  it("returned jobs always satisfy JobSchema invariants", () => {
    // Combine the valid JSON-LD body with arbitrary slugs and URLs to
    // confirm the synthesised Job always validates: non-empty title,
    // non-empty url, source_id present, level_rank matches level,
    // first_seen_at <= last_seen_at.
    const html = readFixtureText("jsonld.job-basic.html");
    fc.assert(
      fc.property(safeSlug, fc.stringMatching(/^[1-9][0-9]{0,8}$/), (slug, jobNum) => {
        const job = parseJsonldJobPage({
          tenant: { slug },
          company: slug,
          url: `https://careers.example.com/job/${jobNum}-x`,
          html,
          observedAt: OBSERVED_AT,
        });
        if (job === null) return true;
        return (
          job.title.length > 0 &&
          job.url.length > 0 &&
          job.source_id.length > 0 &&
          job.ats === "jsonld" &&
          job.tenant_slug === slug &&
          job.first_seen_at <= job.last_seen_at
        );
      }),
      { numRuns: 50 },
    );
  });

  it("parseJsonldSitemap never throws on arbitrary input", () => {
    fc.assert(
      fc.property(fc.string(), (xml) => {
        const urls = parseJsonldSitemap(xml);
        return Array.isArray(urls);
      }),
      { numRuns: 100 },
    );
  });

  it("isJsonldJobUrl never throws on arbitrary input", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (candidate, host) => {
        const out = isJsonldJobUrl(candidate, host);
        return typeof out === "boolean";
      }),
      { numRuns: 100 },
    );
  });
});

describe("isJsonldJobUrl (SSRF guard)", () => {
  it("accepts same-host https URLs whose path contains /job/ or /jobs/", () => {
    expect(isJsonldJobUrl("https://careers.example.com/job/123", "careers.example.com")).toBe(true);
    expect(isJsonldJobUrl("https://careers.example.com/jobs/123", "careers.example.com")).toBe(
      true,
    );
  });

  it("rejects cross-host URLs", () => {
    expect(isJsonldJobUrl("https://other.com/job/123", "careers.example.com")).toBe(false);
  });

  it("rejects http (no TLS)", () => {
    expect(isJsonldJobUrl("http://careers.example.com/job/123", "careers.example.com")).toBe(false);
  });

  it("rejects non-job paths on the same host", () => {
    expect(isJsonldJobUrl("https://careers.example.com/about", "careers.example.com")).toBe(false);
  });

  it("rejects garbage input rather than throwing", () => {
    expect(isJsonldJobUrl("not a url", "careers.example.com")).toBe(false);
  });

  it("rejects loopback / RFC1918 / metadata IPs even when same-host", () => {
    expect(isJsonldJobUrl("https://192.168.1.1/job/123", "192.168.1.1")).toBe(false);
    expect(isJsonldJobUrl("https://10.0.0.1/job/123", "10.0.0.1")).toBe(false);
    expect(isJsonldJobUrl("https://127.0.0.1/job/123", "127.0.0.1")).toBe(false);
    expect(isJsonldJobUrl("https://169.254.169.254/job/x", "169.254.169.254")).toBe(false);
    expect(isJsonldJobUrl("https://172.16.0.1/job/123", "172.16.0.1")).toBe(false);
    expect(isJsonldJobUrl("https://internal.local/job/123", "internal.local")).toBe(false);
  });
});

describe("scrapeJsonldTenant", () => {
  it("walks the sitemap and parses each in-host job page", async () => {
    server.use(
      http.get(SITEMAP_URL, () => HttpResponse.xml(readFixtureText("jsonld.sitemap.small.xml"))),
      http.get("https://careers.example.com/job/1001-engineer", () =>
        HttpResponse.html(readFixtureText("jsonld.job-basic.html")),
      ),
      http.get("https://careers.example.com/job/1002-designer", () =>
        HttpResponse.html(readFixtureText("jsonld.job-remote.html")),
      ),
    );
    const out = await scrapeJsonldTenant({
      tenant: { slug: "example", display_name: "Example Co" },
      client: clientWithRobotsAllowAll(),
      observedAt: OBSERVED_AT,
      sitemapUrl: SITEMAP_URL,
    });
    // The sitemap also lists `/about` (non-job path) and a cross-host
    // URL — both must be filtered before the fetch loop.
    expect(out.jobs).toHaveLength(2);
    expect(out.result.status).toBe("success");
    expect(out.result.jobs_count).toBe(2);
    expect(out.jobs.map((j) => j.title).sort()).toEqual([
      "Senior Designer (Remote)",
      "Senior Software Engineer",
    ]);
  });

  it("marks transient_failure when more than half of job pages fail to parse", async () => {
    server.use(
      http.get(SITEMAP_URL, () => HttpResponse.xml(readFixtureText("jsonld.sitemap.small.xml"))),
      // /1001-engineer parses; /1002-designer returns a no-JSON-LD page;
      // 2 valid job URLs, 1 parses, 1 fails → 1/2 = 50% failure, NOT > 50%
      // so status stays success. Add a third failing URL to flip the
      // threshold.
      http.get("https://careers.example.com/job/1001-engineer", () =>
        HttpResponse.html(readFixtureText("jsonld.edge-no-jsonld.html")),
      ),
      http.get("https://careers.example.com/job/1002-designer", () =>
        HttpResponse.html(readFixtureText("jsonld.edge-no-jsonld.html")),
      ),
    );
    const out = await scrapeJsonldTenant({
      tenant: { slug: "example" },
      client: clientWithRobotsAllowAll(),
      observedAt: OBSERVED_AT,
      sitemapUrl: SITEMAP_URL,
    });
    expect(out.jobs).toHaveLength(0);
    expect(out.result.status).toBe("transient_failure");
    expect(out.result.error).toContain("2/2");
  });

  it("returns dead status on invalid sitemap_url", async () => {
    const out = await scrapeJsonldTenant({
      tenant: { slug: "example" },
      client: clientWithRobotsAllowAll(),
      observedAt: OBSERVED_AT,
      sitemapUrl: "not-a-url",
    });
    expect(out.result.status).toBe("dead");
    expect(out.result.error).toContain("invalid sitemap_url");
  });

  it("rejects unsafe sitemap_url hosts at the scrape boundary (audit M-2)", async () => {
    // The scrape path applies the same SSRF guard as the probe builder.
    // None of these should result in an HTTP request being fired —
    // msw with onUnhandledRequest:"error" would throw if they did.
    for (const sitemapUrl of [
      "http://careers.example.com/sitemap.xml",
      "https://localhost/sitemap.xml",
      "https://example.local/sitemap.xml",
      "https://example.internal/sitemap.xml",
      "https://192.168.1.1/sitemap.xml",
      "https://10.0.0.1/sitemap.xml",
      "https://169.254.169.254/sitemap.xml",
      "https://172.16.0.1/sitemap.xml",
      "https://metadata.google.internal/sitemap.xml",
    ]) {
      const out = await scrapeJsonldTenant({
        tenant: { slug: "example" },
        client: clientWithRobotsAllowAll(),
        observedAt: OBSERVED_AT,
        sitemapUrl,
      });
      expect(out.jobs).toHaveLength(0);
      expect(out.result.status).toBe("dead");
      expect(out.result.error).toContain("unsafe sitemap_url host");
    }
  });

  it("rejects unsafe slugs at the dispatcher boundary", async () => {
    const out = await scrapeJsonldTenant({
      // slug fails assertSafeSlug — must short-circuit before fetching
      tenant: { slug: "../etc/passwd" },
      client: clientWithRobotsAllowAll(),
      observedAt: OBSERVED_AT,
      sitemapUrl: SITEMAP_URL,
    });
    expect(out.jobs).toHaveLength(0);
    expect(out.result.status).toBe("dead");
  });

  it("respects EXPECTED_HOST when sitemap lists cross-host URLs", async () => {
    // The small fixture intentionally includes a cross-host URL; assert
    // we never fetch it. msw will throw on unhandled requests; if we
    // tried to fetch other-host.com the test would error out.
    server.use(
      http.get(SITEMAP_URL, () => HttpResponse.xml(readFixtureText("jsonld.sitemap.small.xml"))),
      http.get("https://careers.example.com/job/1001-engineer", () =>
        HttpResponse.html(readFixtureText("jsonld.job-basic.html")),
      ),
      http.get("https://careers.example.com/job/1002-designer", () =>
        HttpResponse.html(readFixtureText("jsonld.job-remote.html")),
      ),
    );
    const out = await scrapeJsonldTenant({
      tenant: { slug: "example" },
      client: clientWithRobotsAllowAll(),
      observedAt: OBSERVED_AT,
      sitemapUrl: SITEMAP_URL,
    });
    expect(out.jobs).toHaveLength(2);
    expect(EXPECTED_HOST).toBe("careers.example.com");
  });
});
