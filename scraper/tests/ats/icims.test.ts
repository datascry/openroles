import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from "bun:test";
import fc from "fast-check";
import {
  extractJsonLd,
  parseIcimsJobPage,
  parseIcimsSitemap,
  scrapeIcimsTenant,
} from "../../src/ats/icims.ts";
import { HttpClient } from "../../src/http.ts";
import { RobotsTxtCache } from "../../src/robots.ts";
import {
  clientWithRobotsAllowAll,
  HttpResponse,
  http,
  makeServer,
  readFixtureText,
} from "../helpers.ts";

const OBSERVED_AT = "2026-04-26T00:00:00Z";

const server = makeServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("parseIcimsSitemap", () => {
  it("extracts <loc> entries from a sitemap", () => {
    const xml = readFixtureText("icims.sitemap.large.xml");
    const urls = parseIcimsSitemap(xml);
    expect(urls.length).toBe(4);
    expect(urls[0]?.loc).toContain("/jobs/1001/");
  });

  it("returns [] on empty xml", () => {
    expect(parseIcimsSitemap("")).toEqual([]);
  });

  it("returns [] on malformed xml", () => {
    expect(parseIcimsSitemap("<not-a-sitemap>")).toEqual([]);
  });

  it("handles a single <url> entry (non-array form)", () => {
    const xml = '<?xml version="1.0"?><urlset><url><loc>https://x/jobs/1/job</loc></url></urlset>';
    const urls = parseIcimsSitemap(xml);
    expect(urls).toHaveLength(1);
  });
});

describe("extractJsonLd", () => {
  it("returns the JobPosting from a single script tag", () => {
    const html = readFixtureText("icims.job1001.html");
    const jl = extractJsonLd(html);
    expect(jl?.title).toBe("Senior Software Engineer");
  });

  it("finds the JobPosting inside a JSON-LD array", () => {
    const html = readFixtureText("icims.edge-array-jsonld.html");
    const jl = extractJsonLd(html);
    expect(jl?.title).toBe("Job in JSON-LD array");
  });

  it("returns null when no JSON-LD is present", () => {
    const html = readFixtureText("icims.edge-no-jsonld.html");
    expect(extractJsonLd(html)).toBeNull();
  });

  it("ignores JSON-LD inside HTML comments", () => {
    const html = `
      <!--
      <script type="application/ld+json">
      { "@type": "JobPosting", "title": "ghost from comment" }
      </script>
      -->
      <script type="application/ld+json">
      { "@type": "JobPosting", "title": "real one", "hiringOrganization": { "name": "Live" } }
      </script>
    `;
    const jl = extractJsonLd(html);
    expect(jl?.title).toBe("real one");
  });

  it("skips malformed JSON and non-JobPosting blobs", () => {
    const html = readFixtureText("icims.edge-malformed.html");
    expect(extractJsonLd(html)).toBeNull();
  });
});

describe("parseIcimsJobPage (fixture replay)", () => {
  it("parses a job page with full JSON-LD", () => {
    const html = readFixtureText("icims.job1001.html");
    const job = parseIcimsJobPage({
      tenant: { slug: "example", display_name: "Example" },
      company: "Example",
      url: "https://careers-example.icims.com/jobs/1001/senior-software-engineer/job",
      html,
      observedAt: OBSERVED_AT,
    });
    expect(job?.title).toBe("Senior Software Engineer");
    expect(job?.location_country).toBe("US");
    expect(job?.posted_at).toBe("2026-04-22T00:00:00Z");
    expect(job?.source_id).toBe("REQ-1001");
  });

  it("parses a job page with single-object jobLocation and string identifier", () => {
    const html = readFixtureText("icims.job1002.html");
    const job = parseIcimsJobPage({
      tenant: { slug: "example" },
      company: "Example",
      url: "https://careers-example.icims.com/jobs/1002/staff-data-scientist/job",
      html,
      observedAt: OBSERVED_AT,
    });
    expect(job?.workplace_type).toBe("remote");
    expect(job?.posted_at).toBe("2026-04-23T08:00:00Z");
    expect(job?.source_id).toBe("REQ-1002");
  });

  it("flags recruiter titles", () => {
    const html = readFixtureText("icims.job1003.html");
    const job = parseIcimsJobPage({
      tenant: { slug: "example" },
      company: "Example",
      url: "https://careers-example.icims.com/jobs/1003/talent-acquisition-partner/job",
      html,
      observedAt: OBSERVED_AT,
    });
    expect(job?.is_recruiter_post).toBe(true);
    expect(job?.location_country).toBe("GB");
  });

  it("returns null when no JSON-LD is present", () => {
    const html = readFixtureText("icims.edge-no-jsonld.html");
    expect(
      parseIcimsJobPage({
        tenant: { slug: "edge" },
        company: "Edge",
        url: "https://careers-edge.icims.com/jobs/2001/no-jsonld/job",
        html,
        observedAt: OBSERVED_AT,
      }),
    ).toBeNull();
  });

  it("falls back to URL digits for source_id when identifier missing", () => {
    const html = `<script type="application/ld+json">${JSON.stringify({
      "@type": "JobPosting",
      title: "No identifier",
      hiringOrganization: { name: "X" },
    })}</script>`;
    const job = parseIcimsJobPage({
      tenant: { slug: "x" },
      company: "X",
      url: "https://careers-x.icims.com/jobs/9999/no-id/job",
      html,
      observedAt: OBSERVED_AT,
    });
    expect(job?.source_id).toBe("9999");
  });
});

describe("parseIcimsJobPage (property)", () => {
  it("is deterministic on identical input", () => {
    const html = readFixtureText("icims.job1001.html");
    fc.assert(
      fc.property(fc.constantFrom("a", "b"), (slug) => {
        const a = parseIcimsJobPage({
          tenant: { slug },
          company: slug,
          url: "https://careers-example.icims.com/jobs/1001/senior-software-engineer/job",
          html,
          observedAt: OBSERVED_AT,
        });
        const b = parseIcimsJobPage({
          tenant: { slug },
          company: slug,
          url: "https://careers-example.icims.com/jobs/1001/senior-software-engineer/job",
          html,
          observedAt: OBSERVED_AT,
        });
        return JSON.stringify(a) === JSON.stringify(b);
      }),
      { numRuns: 20 },
    );
  });
});

describe("scrapeIcimsTenant", () => {
  it("walks the sitemap and parses each job page", async () => {
    server.use(
      http.get("https://careers-example.icims.com/sitemap.xml", () =>
        HttpResponse.xml(readFixtureText("icims.sitemap.large.xml")),
      ),
      http.get("https://careers-example.icims.com/jobs/1001/senior-software-engineer/job", () =>
        HttpResponse.html(readFixtureText("icims.job1001.html")),
      ),
      http.get("https://careers-example.icims.com/jobs/1002/staff-data-scientist/job", () =>
        HttpResponse.html(readFixtureText("icims.job1002.html")),
      ),
      http.get("https://careers-example.icims.com/jobs/1003/talent-acquisition-partner/job", () =>
        HttpResponse.html(readFixtureText("icims.job1003.html")),
      ),
    );
    const client = clientWithRobotsAllowAll();
    const out = await scrapeIcimsTenant({
      tenant: { slug: "example", display_name: "Example" },
      client,
      observedAt: OBSERVED_AT,
    });
    expect(out.result.status).toBe("success");
    expect(out.result.jobs_count).toBe(3);
  });

  it("downgrades to transient_failure when most job pages fail", async () => {
    server.use(
      http.get("https://careers-edge.icims.com/sitemap.xml", () =>
        HttpResponse.xml(readFixtureText("icims.sitemap.edge.xml")),
      ),
      http.get("https://careers-edge.icims.com/jobs/2001/no-jsonld/job", () =>
        HttpResponse.html(readFixtureText("icims.edge-no-jsonld.html")),
      ),
      http.get("https://careers-edge.icims.com/jobs/2002/array-jsonld/job", () =>
        HttpResponse.html(readFixtureText("icims.edge-array-jsonld.html")),
      ),
      http.get(
        "https://careers-edge.icims.com/jobs/2003/malformed/job",
        () => new HttpResponse("oops", { status: 500 }),
      ),
    );
    const client = clientWithRobotsAllowAll();
    const out = await scrapeIcimsTenant({
      tenant: { slug: "edge" },
      client,
      observedAt: OBSERVED_AT,
      perTenantConcurrency: 2,
    });
    expect(out.result.status).toBe("transient_failure");
    expect(out.result.jobs_count).toBe(1);
    expect(out.result.error).toContain("/3 job pages failed");
  });

  it("retries on sitemap 5xx", async () => {
    let attempts = 0;
    server.use(
      http.get("https://careers-flake.icims.com/sitemap.xml", () => {
        attempts += 1;
        if (attempts < 2) return new HttpResponse("err", { status: 503 });
        return HttpResponse.xml(readFixtureText("icims.sitemap.small.xml"));
      }),
      http.get("https://careers-tinyco.icims.com/jobs/1/founding-engineer/job", () =>
        HttpResponse.html(readFixtureText("icims.tinyco-job1.html")),
      ),
    );
    const client = clientWithRobotsAllowAll();
    const out = await scrapeIcimsTenant({
      tenant: { slug: "flake" },
      client,
      observedAt: OBSERVED_AT,
    });
    expect(out.result.status).toBe("success");
  });

  it("blocks on robots.txt at the sitemap level", async () => {
    const robots = new RobotsTxtCache({
      fetchFn: mock(async () => new Response("User-agent: *\nDisallow: /\n", { status: 200 })),
      clock: () => 0,
    });
    const client = new HttpClient({
      userAgent: "openroles/0.0.0",
      robots,
      sleep: async () => {},
      random: () => 0.5,
      retry: { maxAttempts: 1, baseMs: 1, maxMs: 1 },
    });
    const out = await scrapeIcimsTenant({
      tenant: { slug: "blocked" },
      client,
      observedAt: OBSERVED_AT,
    });
    expect(out.result.status).toBe("dead");
  });
});
