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
