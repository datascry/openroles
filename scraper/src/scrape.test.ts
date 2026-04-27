import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import {
  clientWithRobotsAllowAll,
  HttpResponse,
  http,
  makeServer,
  readFixture,
  readFixtureText,
} from "../tests/helpers.ts";
import { runScrape } from "./scrape.ts";

const server = makeServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const fixedClock = (() => {
  const d = new Date("2026-04-26T00:00:00Z");
  let n = 0;
  return () => new Date(d.getTime() + (n++ === 0 ? 0 : 1000));
})();

describe("runScrape", () => {
  it("dispatches greenhouse and assembles a ScrapeOutput", async () => {
    server.use(
      http.get("https://boards-api.greenhouse.io/v1/boards/example/jobs", () =>
        HttpResponse.json(readFixture("greenhouse.small.json")),
      ),
    );
    const out = await runScrape({
      input: {
        ats: "greenhouse",
        tenants: [{ slug: "example" }],
        userAgent: "openroles/0.0.0 (+https://example.com)",
        contactUrl: "https://example.com/contact",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.jobs).toHaveLength(1);
    expect(out.tenant_results).toHaveLength(1);
    expect(out.tenant_results[0]?.status).toBe("success");
    expect(out.ats).toBe("greenhouse");
  });

  it("dispatches lever", async () => {
    server.use(
      http.get("https://api.lever.co/v0/postings/example", () =>
        HttpResponse.json(readFixture("lever.small.json")),
      ),
    );
    const out = await runScrape({
      input: {
        ats: "lever",
        tenants: [{ slug: "example" }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.jobs).toHaveLength(1);
  });

  it("dispatches ashby", async () => {
    server.use(
      http.get("https://api.ashbyhq.com/posting-api/job-board/example", () =>
        HttpResponse.json(readFixture("ashby.small.json")),
      ),
    );
    const out = await runScrape({
      input: {
        ats: "ashby",
        tenants: [{ slug: "example" }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.jobs).toHaveLength(1);
  });

  it("dispatches bamboohr", async () => {
    server.use(
      http.get("https://example.bamboohr.com/careers/list", () =>
        HttpResponse.json(readFixture("bamboohr.small.json")),
      ),
    );
    const out = await runScrape({
      input: {
        ats: "bamboohr",
        tenants: [{ slug: "example" }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.jobs).toHaveLength(1);
  });

  it("dispatches workday with metadata.host and metadata.site", async () => {
    const host = "example.wd5.myworkdayjobs.com";
    server.use(
      http.post(`https://${host}/wday/cxs/example/External/jobs`, () =>
        HttpResponse.json(readFixture("workday.small.json")),
      ),
    );
    const out = await runScrape({
      input: {
        ats: "workday",
        tenants: [{ slug: "example", metadata: { host, site: "External" } }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.jobs).toHaveLength(1);
  });

  it("flags workday tenant dead when metadata is missing", async () => {
    const out = await runScrape({
      input: {
        ats: "workday",
        tenants: [{ slug: "missing-meta" }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.tenant_results[0]?.status).toBe("dead");
    expect(out.tenant_results[0]?.error).toContain("metadata");
  });

  it("dispatches icims using the full subdomain label as the slug", async () => {
    // iCIMS slug is the entire subdomain label (most production tenants use
    // the `careers-` prefix, but many use other branded prefixes); the URL
    // composer is `https://{slug}.icims.com/sitemap.xml` with no stripping.
    server.use(
      http.get("https://careers-tinyco.icims.com/sitemap.xml", () =>
        HttpResponse.xml(readFixtureText("icims.sitemap.small.xml")),
      ),
      http.get("https://careers-tinyco.icims.com/jobs/1/founding-engineer/job", () =>
        HttpResponse.html(readFixtureText("icims.tinyco-job1.html")),
      ),
    );
    const out = await runScrape({
      input: {
        ats: "icims",
        tenants: [{ slug: "careers-tinyco" }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.jobs).toHaveLength(1);
  });

  it("dispatches recruitee against the public /api/offers/ endpoint", async () => {
    server.use(
      http.get("https://example.recruitee.com/api/offers/", () =>
        HttpResponse.json({
          offers: [
            {
              id: 42,
              title: "Senior Software Engineer",
              location: "Remote",
              country_code: "us",
              city: "Remote",
              remote: true,
              description: "Build cool stuff.",
              careers_url: "https://example.recruitee.com/o/senior-software-engineer-42",
              created_at: "2026-04-20T09:00:00Z",
              department: "Engineering",
            },
          ],
        }),
      ),
    );
    const out = await runScrape({
      input: {
        ats: "recruitee",
        tenants: [{ slug: "example", display_name: "Example Co" }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.jobs).toHaveLength(1);
    expect(out.jobs[0]?.workplace_type).toBe("remote");
    expect(out.jobs[0]?.location_country).toBe("US");
    expect(out.tenant_results[0]?.status).toBe("success");
  });

  it("dispatches breezy against the public /json endpoint", async () => {
    server.use(
      http.get("https://example.breezy.hr/json", () =>
        HttpResponse.json({
          company: { name: "Example Inc" },
          positions: [
            {
              _id: "abc123",
              name: "Staff Engineer",
              location: { name: "Berlin", country: { code: "de" }, city: { name: "Berlin" } },
              category: { name: "Engineering" },
              description: "Lead the platform.",
              url: "https://example.breezy.hr/p/abc123",
              published_date: "2026-04-22T12:00:00Z",
              is_remote: false,
            },
          ],
        }),
      ),
    );
    const out = await runScrape({
      input: {
        ats: "breezy",
        tenants: [{ slug: "example" }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.jobs).toHaveLength(1);
    expect(out.jobs[0]?.company).toBe("Example Inc");
    expect(out.jobs[0]?.location_country).toBe("DE");
    expect(out.jobs[0]?.workplace_type).toBeNull();
  });

  it("dispatches personio against the public /xml feed", async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<workzag-jobs>
  <position>
    <id>9001</id>
    <name>Backend Engineer</name>
    <office>Munich</office>
    <department>Engineering</department>
    <createdAt>2026-04-18T08:00:00Z</createdAt>
    <jobDescription>
      <jobDescription>
        <name>About</name>
        <value>We build payment infra.</value>
      </jobDescription>
    </jobDescription>
  </position>
</workzag-jobs>`;
    server.use(http.get("https://example.jobs.personio.com/xml", () => HttpResponse.xml(xml)));
    const out = await runScrape({
      input: {
        ats: "personio",
        tenants: [{ slug: "example" }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.jobs).toHaveLength(1);
    expect(out.jobs[0]?.title).toBe("Backend Engineer");
    expect(out.jobs[0]?.location_text).toBe("Munich");
  });

  it("dispatches workable against the apply.workable.com v3 API", async () => {
    server.use(
      http.get("https://apply.workable.com/api/v3/accounts/example/jobs", () =>
        HttpResponse.json({
          results: [
            {
              shortcode: "ABCD1234",
              title: "Principal Engineer",
              location: { country_code: "GB", city: "London", location_str: "London, UK" },
              department: "Engineering",
              workplace: "hybrid",
              published_on: "2026-04-19T10:00:00Z",
              description: "Lead architecture.",
            },
          ],
        }),
      ),
    );
    const out = await runScrape({
      input: {
        ats: "workable",
        tenants: [{ slug: "example" }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.jobs).toHaveLength(1);
    expect(out.jobs[0]?.workplace_type).toBe("hybrid");
    expect(out.jobs[0]?.location_country).toBe("GB");
  });

  it("recruitee handles hybrid workplace_type and surfaces failures as errorToResult", async () => {
    server.use(
      http.get("https://hybridco.recruitee.com/api/offers/", () =>
        HttpResponse.json({
          offers: [
            {
              id: 1,
              title: "Hybrid Role",
              hybrid: true,
              created_at: 1714000000, // epoch seconds
            },
          ],
        }),
      ),
      http.get("https://broken.recruitee.com/api/offers/", () =>
        HttpResponse.text("nope", { status: 503 }),
      ),
    );
    const ok = await runScrape({
      input: {
        ats: "recruitee",
        tenants: [{ slug: "hybridco" }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(ok.jobs[0]?.workplace_type).toBe("hybrid");
    expect(ok.jobs[0]?.posted_at).toBeDefined();
    const failed = await runScrape({
      input: {
        ats: "recruitee",
        tenants: [{ slug: "broken" }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(failed.tenant_results[0]?.status).not.toBe("success");
  });

  it("workable maps onsite workplace and surfaces 5xx as transient_failure", async () => {
    server.use(
      http.get("https://apply.workable.com/api/v3/accounts/onsiteco/jobs", () =>
        HttpResponse.json({
          results: [
            {
              shortcode: "X1",
              title: "Onsite Engineer",
              workplace: "On-site",
              published_on: "2026-04-19T10:00:00Z",
            },
          ],
        }),
      ),
      http.get("https://apply.workable.com/api/v3/accounts/down/jobs", () =>
        HttpResponse.text("oops", { status: 503 }),
      ),
    );
    const ok = await runScrape({
      input: {
        ats: "workable",
        tenants: [{ slug: "onsiteco" }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(ok.jobs[0]?.workplace_type).toBe("onsite");
    const failed = await runScrape({
      input: {
        ats: "workable",
        tenants: [{ slug: "down" }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(failed.tenant_results[0]?.status).not.toBe("success");
  });

  it("flags teamtailor / smartrecruiters as transient_failure (scrapers not yet implemented)", async () => {
    for (const ats of ["teamtailor", "smartrecruiters"] as const) {
      const out = await runScrape({
        input: {
          ats,
          tenants: [{ slug: "example" }],
          userAgent: "openroles/0.0.0",
          contactUrl: "https://example.com",
        },
        clock: fixedClock,
        httpClient: clientWithRobotsAllowAll(),
      });
      expect(out.jobs).toHaveLength(0);
      expect(out.tenant_results[0]?.status).toBe("transient_failure");
      expect(out.tenant_results[0]?.error).toContain("not yet implemented");
    }
  });

  it("returns an empty output for an empty tenants array", async () => {
    const out = await runScrape({
      input: {
        ats: "greenhouse",
        tenants: [],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.jobs).toHaveLength(0);
    expect(out.tenant_results).toHaveLength(0);
  });

  it("preserves tenant order in tenant_results across concurrent requests", async () => {
    server.use(
      http.get("https://boards-api.greenhouse.io/v1/boards/aaa/jobs", async () => {
        await new Promise((r) => setTimeout(r, 30));
        return HttpResponse.json(readFixture("greenhouse.small.json"));
      }),
      http.get("https://boards-api.greenhouse.io/v1/boards/bbb/jobs", () =>
        HttpResponse.json(readFixture("greenhouse.small.json")),
      ),
    );
    const out = await runScrape({
      input: {
        ats: "greenhouse",
        tenants: [{ slug: "aaa" }, { slug: "bbb" }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.tenant_results.map((r) => r.slug)).toEqual(["aaa", "bbb"]);
  });

  it("surfaces real metrics from the HttpClient counter", async () => {
    server.use(
      http.get("https://boards-api.greenhouse.io/v1/boards/example/jobs", () =>
        HttpResponse.json(readFixture("greenhouse.small.json"), {
          headers: { "content-length": "100" },
        }),
      ),
    );
    const out = await runScrape({
      input: {
        ats: "greenhouse",
        tenants: [{ slug: "example" }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.metrics.requests_made).toBeGreaterThan(0);
  });

  it("rejects workday tenant with invalid host metadata", async () => {
    const out = await runScrape({
      input: {
        ats: "workday",
        tenants: [{ slug: "evil", metadata: { host: "attacker.example.com", site: "External" } }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.tenant_results[0]?.status).toBe("dead");
    expect(out.tenant_results[0]?.error).toContain("workday host rejected");
  });

  it("rejects an invalid input via zod", async () => {
    await expect(
      runScrape({
        input: {
          ats: "rippling" as any,
          tenants: [],
          userAgent: "openroles/0.0.0",
          contactUrl: "https://example.com",
        },
      }),
    ).rejects.toThrow();
  });
});
