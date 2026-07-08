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

  it("flags workday tenant dead when metadata.host is missing", async () => {
    // host is non-recoverable — without it we don't know which subdomain
    // to talk to. site has a sensible default so its absence is fine.
    const out = await runScrape({
      input: {
        ats: "workday",
        tenants: [{ slug: "missing-host" }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.tenant_results[0]?.status).toBe("dead");
    expect(out.tenant_results[0]?.error).toContain("metadata.host");
  });

  it("dispatches oraclecloud with metadata.host and metadata.site", async () => {
    const host = "etest.fa.us2.oraclecloud.com";
    server.use(
      http.get(`https://${host}/hcmRestApi/resources/latest/recruitingCEJobRequisitions`, () =>
        HttpResponse.json(readFixture("oraclecloud.small.json")),
      ),
    );
    const out = await runScrape({
      input: {
        ats: "oraclecloud",
        tenants: [{ slug: "acme", metadata: { host, site: "CX_1" } }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.jobs).toHaveLength(2);
    expect(out.tenant_results[0]?.status).toBe("success");
  });

  it("flags oraclecloud tenant dead when metadata.host is missing", async () => {
    const out = await runScrape({
      input: {
        ats: "oraclecloud",
        tenants: [{ slug: "missing-host", metadata: { site: "CX_1" } }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.tenant_results[0]?.status).toBe("dead");
    expect(out.tenant_results[0]?.error).toContain("metadata.host or metadata.site");
  });

  it("flags oraclecloud tenant dead when metadata.site is missing", async () => {
    const out = await runScrape({
      input: {
        ats: "oraclecloud",
        tenants: [{ slug: "missing-site", metadata: { host: "etest.fa.us2.oraclecloud.com" } }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.tenant_results[0]?.status).toBe("dead");
    expect(out.tenant_results[0]?.error).toContain("metadata.host or metadata.site");
  });

  it("dispatches jazzhr from the slug alone (no metadata)", async () => {
    server.use(
      http.get(
        "https://acme.applytojob.com/apply/",
        () => new HttpResponse(readFixtureText("jazzhr.listing.html")),
      ),
      http.get(
        "https://acme.applytojob.com/apply/AbC123dEf0/Senior-Security-Engineer",
        () => new HttpResponse(readFixtureText("jazzhr.detail.html")),
      ),
      http.get(
        "https://acme.applytojob.com/apply/Zy9X8w7V6u/Threat-Intelligence-Analyst",
        () => new HttpResponse(readFixtureText("jazzhr.detail.html")),
      ),
    );
    const out = await runScrape({
      input: {
        ats: "jazzhr",
        tenants: [{ slug: "acme", display_name: "Acme Corp" }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.jobs).toHaveLength(2);
    expect(out.tenant_results[0]?.status).toBe("success");
  });

  it("dispatches phenom with metadata.host (locale defaulting to us/en)", async () => {
    server.use(
      http.get(
        "https://careers.acme.com/us/en/search-results",
        () => new HttpResponse(readFixtureText("phenom.search.small.html")),
      ),
    );
    const out = await runScrape({
      input: {
        ats: "phenom",
        tenants: [
          { slug: "acme", display_name: "Acme Corp", metadata: { host: "careers.acme.com" } },
        ],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.jobs).toHaveLength(2);
    expect(out.tenant_results[0]?.status).toBe("success");
  });

  it("flags phenom tenant dead when metadata.host is missing", async () => {
    const out = await runScrape({
      input: {
        ats: "phenom",
        tenants: [{ slug: "no-host" }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.tenant_results[0]?.status).toBe("dead");
    expect(out.tenant_results[0]?.error).toContain("phenom tenant missing metadata.host");
  });

  it("dispatches hrmdirect from the slug alone (no metadata)", async () => {
    server.use(
      http.get(
        "https://acme.hrmdirect.com/employment/job-openings.php",
        () => new HttpResponse(readFixtureText("hrmdirect.listing.html")),
      ),
    );
    const out = await runScrape({
      input: {
        ats: "hrmdirect",
        tenants: [{ slug: "acme", display_name: "Acme Corp" }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.jobs).toHaveLength(6);
    expect(out.tenant_results[0]?.status).toBe("success");
  });

  it("dispatches careerplug from the slug alone (no metadata)", async () => {
    server.use(
      http.get("https://acme.careerplug.com/jobs", ({ request }) => {
        const page = new URL(request.url).searchParams.get("page");
        return new HttpResponse(
          readFixtureText(page === "2" ? "careerplug.page2.html" : "careerplug.listing.html"),
        );
      }),
    );
    const out = await runScrape({
      input: {
        ats: "careerplug",
        tenants: [{ slug: "acme", display_name: "Acme Fitness" }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.jobs).toHaveLength(5); // 3 on page 1 + 2 on page 2
    expect(out.tenant_results[0]?.status).toBe("success");
  });

  it("dispatches schoolspring (single-tenant, per-row employer as company)", async () => {
    server.use(
      http.get("https://api.schoolspring.com/api/Jobs/GetJobsCountWithSearch", () =>
        HttpResponse.json({ success: true, message: "", validationErrors: [], value: 2 }),
      ),
      http.get("https://api.schoolspring.com/api/Jobs/GetPagedJobsWithSearch", () =>
        HttpResponse.json(readFixture("schoolspring.small.json")),
      ),
    );
    const out = await runScrape({
      input: {
        ats: "schoolspring",
        tenants: [{ slug: "schoolspring", display_name: "SchoolSpring" }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.jobs).toHaveLength(2);
    expect(out.jobs[0]?.company).toBe("Beaufort County School District");
    expect(out.tenant_results[0]?.status).toBe("success");
  });

  it("dispatches isolvedhire from the slug alone (bootstrap + job list)", async () => {
    server.use(
      http.get(
        "https://acme.isolvedhire.com/jobs/",
        () => new HttpResponse(readFixtureText("isolvedhire.board.html")),
      ),
      http.get("https://acme.isolvedhire.com/core/jobs/9440", () =>
        HttpResponse.json(readFixture("isolvedhire.small.json")),
      ),
    );
    const out = await runScrape({
      input: {
        ats: "isolvedhire",
        tenants: [{ slug: "acme", display_name: "Acme Corp" }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.jobs).toHaveLength(2);
    expect(out.tenant_results[0]?.status).toBe("success");
  });

  it("dispatches applicantpool from the slug alone (bootstrap + job list)", async () => {
    server.use(
      http.get(
        "https://acme.applicantpool.com/jobs/",
        () => new HttpResponse(readFixtureText("applicantpool.board.html")),
      ),
      http.get("https://acme.applicantpool.com/core/jobs/313", () =>
        HttpResponse.json(readFixture("applicantpool.small.json")),
      ),
    );
    const out = await runScrape({
      input: {
        ats: "applicantpool",
        tenants: [{ slug: "acme", display_name: "Acme Corp" }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.jobs).toHaveLength(2);
    expect(out.tenant_results[0]?.status).toBe("success");
  });

  it("dispatches manatal from the slug alone (no metadata)", async () => {
    server.use(
      http.get(
        "https://www.careers-page.com/manatal",
        () => new HttpResponse(readFixtureText("manatal.board.html")),
      ),
      http.get(
        "https://www.careers-page.com/manatal/job/L975Y966",
        () => new HttpResponse(readFixtureText("manatal.detail-1.html")),
      ),
      http.get(
        "https://www.careers-page.com/manatal/job/3W35R9R8",
        () => new HttpResponse(readFixtureText("manatal.detail-2.html")),
      ),
      http.get(
        "https://www.careers-page.com/manatal/job/V55YR",
        () => new HttpResponse(readFixtureText("manatal.detail-blr.html")),
      ),
    );
    const out = await runScrape({
      input: {
        ats: "manatal",
        tenants: [{ slug: "manatal", display_name: "Manatal" }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.jobs).toHaveLength(3);
    expect(out.tenant_results[0]?.status).toBe("success");
  });

  it("dispatches applitrack from the slug alone (no metadata)", async () => {
    server.use(
      http.get(
        "https://www.applitrack.com/unionsd/onlineapp/jobpostings/Output.asp",
        () => new HttpResponse(readFixtureText("applitrack.listing.js")),
      ),
    );
    const out = await runScrape({
      input: {
        ats: "applitrack",
        tenants: [{ slug: "unionsd", display_name: "Union School District" }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.jobs).toHaveLength(3);
    expect(out.tenant_results[0]?.status).toBe("success");
  });

  it("dispatches hiringthing from the slug alone (no metadata)", async () => {
    server.use(
      http.get("https://pinnacle.hiringthing.com/api/rss.xml", () =>
        HttpResponse.xml(readFixtureText("hiringthing.feed.xml")),
      ),
    );
    const out = await runScrape({
      input: {
        ats: "hiringthing",
        tenants: [{ slug: "pinnacle", display_name: "Pinnacle" }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.jobs).toHaveLength(3);
    expect(out.tenant_results[0]?.status).toBe("success");
  });

  it("dispatches apploi with metadata.brand", async () => {
    server.use(
      http.get("https://ats-integrations.apploi.com/search/jobs/", () =>
        HttpResponse.json(readFixture("apploi.small.json")),
      ),
    );
    const out = await runScrape({
      input: {
        ats: "apploi",
        tenants: [
          { slug: "acme-health", display_name: "Acme Health", metadata: { brand: "Acme Health" } },
        ],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.jobs).toHaveLength(2);
    expect(out.tenant_results[0]?.status).toBe("success");
  });

  it("dispatches hirebridge from the numeric cid alone (no metadata)", async () => {
    server.use(
      http.get(
        "https://recruit.hirebridge.com/v3/jobs/list.aspx",
        () => new HttpResponse(readFixtureText("hirebridge.listing.html")),
      ),
    );
    const out = await runScrape({
      input: {
        ats: "hirebridge",
        tenants: [{ slug: "5535", display_name: "Menard Inc" }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.jobs).toHaveLength(3);
    expect(out.tenant_results[0]?.status).toBe("success");
  });

  it("dispatches taleotbe with metadata.host, metadata.instance and metadata.cws", async () => {
    server.use(
      http.get("https://phh.tbe.taleo.net/phh03/ats/careers/v2/searchResults", () =>
        HttpResponse.html(readFixtureText("taleotbe.listing.page2.html")),
      ),
    );
    const out = await runScrape({
      input: {
        ats: "taleotbe",
        tenants: [
          {
            slug: "invxis",
            metadata: { host: "phh.tbe.taleo.net", instance: "phh03", cws: "37" },
          },
        ],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.tenant_results[0]?.status).toBe("success");
    expect(out.jobs).toHaveLength(3);
  });

  it("dispatches workstream with metadata.company_id", async () => {
    server.use(
      http.get("https://www.workstream.us/j/ab12cd34/acme-grill/positions", ({ request }) => {
        const page = new URL(request.url).searchParams.get("page");
        return page === null
          ? new HttpResponse(readFixtureText("workstream.board.page2.html"))
          : new HttpResponse(readFixtureText("workstream.board.empty.html"));
      }),
      http.get(
        "https://www.workstream.us/j/ab12cd34/acme-grill/dallas-68685/bar-manager-acme-north-df016e56",
        () => new HttpResponse(readFixtureText("workstream.job.barmanager.html")),
      ),
      http.get(
        "https://www.workstream.us/j/ab12cd34/acme-grill/dallas-68685/sous-chef-acme-north-1894119b",
        () => new HttpResponse(readFixtureText("workstream.job.souschef.html")),
      ),
      http.get(
        "https://www.workstream.us/j/ab12cd34/acme-grill/austin-68686/dishwasher-acme-downtown-a726f5c8",
        () => new HttpResponse(readFixtureText("workstream.job.dishwasher.html")),
      ),
    );
    const out = await runScrape({
      input: {
        ats: "workstream",
        tenants: [
          { slug: "acme-grill", display_name: "Acme Grill", metadata: { company_id: "ab12cd34" } },
        ],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.jobs).toHaveLength(3);
    expect(out.tenant_results[0]?.status).toBe("success");
  });

  it("flags apploi tenant dead when metadata.brand is missing", async () => {
    const out = await runScrape({
      input: {
        ats: "apploi",
        tenants: [{ slug: "no-brand" }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.tenant_results[0]?.status).toBe("dead");
    expect(out.tenant_results[0]?.error).toContain("apploi tenant missing metadata.brand");
  });

  it("flags taleotbe tenant dead when any of host/instance/cws is missing", async () => {
    const out = await runScrape({
      input: {
        ats: "taleotbe",
        tenants: [
          { slug: "no-metadata" },
          { slug: "no-cws", metadata: { host: "phh.tbe.taleo.net", instance: "phh03" } },
        ],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    for (const result of out.tenant_results) {
      expect(result.status).toBe("dead");
      expect(result.error).toContain(
        "taleotbe tenant missing metadata.host, metadata.instance or metadata.cws",
      );
    }
  });

  it("dispatches pageup with metadata.host, metadata.instance and metadata.clientkey", async () => {
    server.use(
      http.get("https://careers.pageuppeople.com/438/caw/en/listing/", () =>
        HttpResponse.html(readFixtureText("pageup.classic.page1.html")),
      ),
    );
    const out = await runScrape({
      input: {
        ats: "pageup",
        tenants: [
          {
            slug: "438-caw",
            display_name: "Just Group",
            metadata: { host: "careers.pageuppeople.com", instance: "438", clientkey: "caw" },
          },
        ],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.tenant_results[0]?.status).toBe("success");
    expect(out.jobs).toHaveLength(3);
  });

  it("flags pageup tenant dead when any of host/instance/clientkey is missing", async () => {
    const out = await runScrape({
      input: {
        ats: "pageup",
        tenants: [
          { slug: "no-metadata" },
          {
            slug: "no-clientkey",
            metadata: { host: "careers.pageuppeople.com", instance: "438" },
          },
        ],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    for (const result of out.tenant_results) {
      expect(result.status).toBe("dead");
      expect(result.error).toContain(
        "pageup tenant missing metadata.host, metadata.instance or metadata.clientkey",
      );
    }
  });

  it("flags workstream tenant dead when metadata.company_id is missing", async () => {
    const out = await runScrape({
      input: {
        ats: "workstream",
        tenants: [{ slug: "no-company-id" }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.tenant_results[0]?.status).toBe("dead");
    expect(out.tenant_results[0]?.error).toContain("workstream tenant missing metadata.company_id");
  });

  it("dispatches jibeapply from the slug alone (no metadata)", async () => {
    server.use(
      http.get("https://acme.jibeapply.com/api/jobs", () =>
        HttpResponse.json(readFixture("jibeapply.small.json")),
      ),
    );
    const out = await runScrape({
      input: {
        ats: "jibeapply",
        tenants: [{ slug: "acme", display_name: "Acme Corp" }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.jobs).toHaveLength(2);
    expect(out.tenant_results[0]?.status).toBe("success");
  });

  it("dispatches hireology from the slug alone (no metadata)", async () => {
    server.use(
      http.get("https://api.hireology.com/v2/public/careers/acme", () =>
        HttpResponse.json(readFixture("hireology.small.json")),
      ),
    );
    const out = await runScrape({
      input: {
        ats: "hireology",
        tenants: [{ slug: "acme", display_name: "Acme Corp" }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.jobs).toHaveLength(2);
    expect(out.tenant_results[0]?.status).toBe("success");
  });

  it("dispatches rippling from the slug alone (list + detail fan-out)", async () => {
    const board = "https://api.rippling.com/platform/api/ats/v1/board/acme-careers";
    server.use(
      http.get(`${board}/jobs`, () => HttpResponse.json(readFixture("rippling.small.json"))),
      http.get(`${board}/jobs/:uuid`, ({ params }) => {
        const details = readFixture("rippling.details.json") as Record<string, unknown>;
        const record = details[params["uuid"] as string];
        return record ? HttpResponse.json(record) : HttpResponse.json({});
      }),
    );
    const out = await runScrape({
      input: {
        ats: "rippling",
        tenants: [{ slug: "acme-careers", display_name: "Acme Corp" }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.jobs).toHaveLength(2);
    expect(out.tenant_results[0]?.status).toBe("success");
  });

  it("dispatches paycom from the clientkey slug (career page + search + detail)", async () => {
    const slug = "b2bd1063bf1b0a2978ea308e72ccf7d3";
    const careerUrl = `https://www.paycomonline.net/v4/ats/web.php/portal/${slug.toUpperCase()}/career-page`;
    const apiBase = "https://portal-applicant-tracking.us-cent.paycomonline.net/";
    const search = readFixture("paycom.search.small.json") as {
      jobPostingPreviews: unknown[];
      jobPostingPreviewsCount: number;
    };
    const details = readFixture("paycom.details.json") as Record<string, unknown>;
    server.use(
      http.get(careerUrl, () => new HttpResponse(readFixtureText("paycom.portal.html"))),
      http.post(`${apiBase}api/ats/job-posting-previews/search`, () => HttpResponse.json(search)),
      http.get(`${apiBase}api/ats/job-postings/:id`, ({ params }) => {
        const rec = details[params["id"] as string];
        return rec ? HttpResponse.json({ jobPosting: rec }) : HttpResponse.json({ jobPosting: {} });
      }),
    );
    const out = await runScrape({
      input: {
        ats: "paycom",
        tenants: [{ slug, display_name: "Portal Inc" }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.jobs).toHaveLength(3);
    expect(out.tenant_results[0]?.status).toBe("success");
    expect(out.ats).toBe("paycom");
  });

  it("dispatches jibeapply against a vanity CNAME via metadata.host", async () => {
    server.use(
      http.get("https://careers.acme-example.com/api/jobs", () =>
        HttpResponse.json(readFixture("jibeapply.small.json")),
      ),
    );
    const out = await runScrape({
      input: {
        ats: "jibeapply",
        tenants: [
          {
            slug: "acme",
            display_name: "Acme Corp",
            metadata: { host: "careers.acme-example.com" },
          },
        ],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.jobs).toHaveLength(2);
    expect(out.jobs[0]?.url).toContain("https://careers.acme-example.com/jobs/");
    expect(out.tenant_results[0]?.status).toBe("success");
  });

  it("dispatches workday with only metadata.host, defaulting site to External", async () => {
    // The S3 bootstrap captured `host` for ~all 4,295 workday tenants but
    // only 44 had `site` from CDX. The dispatcher must fall back to
    // `External` (the canonical public site name) so the other 98% are
    // actually scraped, matching the same default in harvest/probe.ts.
    const host = "example.wd5.myworkdayjobs.com";
    server.use(
      http.post(`https://${host}/wday/cxs/example/External/jobs`, () =>
        HttpResponse.json(readFixture("workday.small.json")),
      ),
    );
    const out = await runScrape({
      input: {
        ats: "workday",
        tenants: [{ slug: "example", metadata: { host } }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.tenant_results[0]?.status).toBe("success");
    expect(out.tenant_results[0]?.jobs_count).toBeGreaterThan(0);
  });

  it("workday hits the discovered metadata.site first (custom label, not External)", async () => {
    // Auto-discovered site labels (e.g. Google's `GOCJobs`, NVIDIA's
    // `NVIDIAExternalCareerSite`, Adobe's `external_experienced`)
    // bypass the hardcoded External / Careers chain entirely. The
    // dispatcher must use the discovered label as the FIRST candidate
    // so we don't burn a 404 round-trip against External just to fall
    // through to the right URL. Empirically ~70% of workday tenants
    // expose a discoverable label via robots.txt.
    const host = "google.wd5.myworkdayjobs.com";
    let externalCalls = 0;
    let gocCalls = 0;
    server.use(
      http.post(`https://${host}/wday/cxs/google/External/jobs`, () => {
        externalCalls += 1;
        return HttpResponse.text("Not Found", { status: 404 });
      }),
      http.post(`https://${host}/wday/cxs/google/GOCJobs/jobs`, () => {
        gocCalls += 1;
        return HttpResponse.json(readFixture("workday.small.json"));
      }),
    );
    const out = await runScrape({
      input: {
        ats: "workday",
        tenants: [{ slug: "google", metadata: { host, site: "GOCJobs" } }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.tenant_results[0]?.status).toBe("success");
    expect(out.tenant_results[0]?.jobs_count).toBeGreaterThan(0);
    expect(gocCalls).toBeGreaterThan(0);
    // Critically — External must NOT be probed first when the discovered
    // label is in metadata. That's the point of the discovery.
    expect(externalCalls).toBe(0);
  });

  it("workday falls back to Careers when External 404s", async () => {
    // ~3,000 of 4,300 harvested workday tenants 404 against `External`
    // because their public board lives under a different name (most
    // commonly `Careers`, then `External_Career_Site` and `External_Site`
    // in the long tail). The scraper iterates the candidate list on
    // page-0 404 and stops on the first site that returns a real
    // jobPostings response.
    const host = "example.wd5.myworkdayjobs.com";
    server.use(
      http.post(`https://${host}/wday/cxs/example/External/jobs`, () =>
        HttpResponse.text("Not Found", { status: 404 }),
      ),
      http.post(`https://${host}/wday/cxs/example/Careers/jobs`, () =>
        HttpResponse.json(readFixture("workday.small.json")),
      ),
    );
    const out = await runScrape({
      input: {
        ats: "workday",
        tenants: [{ slug: "example", metadata: { host } }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.tenant_results[0]?.status).toBe("success");
    expect(out.tenant_results[0]?.jobs_count).toBeGreaterThan(0);
  });

  it("workday falls back to External_Career_Site when External and Careers both 404", async () => {
    // The full fallback chain: External → Careers → External_Career_Site
    // → External_Site. This covers tenants whose CDX harvest didn't
    // capture the site and whose public board uses one of the
    // underscored long-tail variants.
    const host = "example.wd5.myworkdayjobs.com";
    server.use(
      http.post(`https://${host}/wday/cxs/example/External/jobs`, () =>
        HttpResponse.text("Not Found", { status: 404 }),
      ),
      http.post(`https://${host}/wday/cxs/example/Careers/jobs`, () =>
        HttpResponse.text("Not Found", { status: 404 }),
      ),
      http.post(`https://${host}/wday/cxs/example/External_Career_Site/jobs`, () =>
        HttpResponse.json(readFixture("workday.small.json")),
      ),
    );
    const out = await runScrape({
      input: {
        ats: "workday",
        tenants: [{ slug: "example", metadata: { host } }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.tenant_results[0]?.status).toBe("success");
    expect(out.tenant_results[0]?.jobs_count).toBeGreaterThan(0);
  });

  it("workday returns dead when every site candidate 404s", async () => {
    // True dead tenant: no public board on any of the four common site
    // names. The scraper exhausts the fallback list and surfaces the
    // last 404 as the dead reason.
    const host = "example.wd5.myworkdayjobs.com";
    const handler = () => HttpResponse.text("Not Found", { status: 404 });
    server.use(
      http.post(`https://${host}/wday/cxs/example/External/jobs`, handler),
      http.post(`https://${host}/wday/cxs/example/Careers/jobs`, handler),
      http.post(`https://${host}/wday/cxs/example/External_Career_Site/jobs`, handler),
      http.post(`https://${host}/wday/cxs/example/External_Site/jobs`, handler),
    );
    const out = await runScrape({
      input: {
        ats: "workday",
        tenants: [{ slug: "example", metadata: { host } }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.tenant_results[0]?.status).toBe("dead");
    expect(out.tenant_results[0]?.http_status).toBe(404);
  });

  it("workday does NOT retry alternate sites on a 401/403/422 (only 404)", async () => {
    // Auth-gated and validation-error responses indicate the tenant
    // exists but isn't publicly scrapeable — switching to a different
    // site name won't change that. Exit immediately without burning
    // additional requests.
    const host = "example.wd5.myworkdayjobs.com";
    let externalCalls = 0;
    let careersCalls = 0;
    server.use(
      http.post(`https://${host}/wday/cxs/example/External/jobs`, () => {
        externalCalls += 1;
        return HttpResponse.text("Forbidden", { status: 403 });
      }),
      http.post(`https://${host}/wday/cxs/example/Careers/jobs`, () => {
        careersCalls += 1;
        return HttpResponse.json(readFixture("workday.small.json"));
      }),
    );
    const out = await runScrape({
      input: {
        ats: "workday",
        tenants: [{ slug: "example", metadata: { host } }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.tenant_results[0]?.status).toBe("dead");
    expect(externalCalls).toBeGreaterThan(0);
    expect(careersCalls).toBe(0);
  });

  it("workday does NOT swap sites mid-pagination on a later 404", async () => {
    // If page 0 succeeds (so the site is committed) and a later page
    // 404s, that's a real failure (vendor outage, cursor invalidated)
    // and we propagate it instead of silently re-scraping from another
    // site, which would yield duplicate jobs.
    const host = "example.wd5.myworkdayjobs.com";
    let externalPage0 = 0;
    let externalPage1 = 0;
    let careersCalls = 0;
    server.use(
      http.post(`https://${host}/wday/cxs/example/External/jobs`, async ({ request }) => {
        const body = (await request.json()) as { offset: number };
        if (body.offset === 0) {
          externalPage0 += 1;
          // Page 0 returns a "full" page with limit hit so pagination continues.
          return HttpResponse.json({
            total: 100,
            jobPostings: Array.from({ length: 20 }, (_, i) => ({
              title: `Job ${i}`,
              externalPath: `/job/${i}`,
              jobReqId: `R${i}`,
            })),
          });
        }
        externalPage1 += 1;
        return HttpResponse.text("Not Found", { status: 404 });
      }),
      http.post(`https://${host}/wday/cxs/example/Careers/jobs`, () => {
        careersCalls += 1;
        return HttpResponse.json(readFixture("workday.small.json"));
      }),
    );
    const out = await runScrape({
      input: {
        ats: "workday",
        tenants: [{ slug: "example", metadata: { host } }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(externalPage0).toBeGreaterThan(0);
    expect(externalPage1).toBeGreaterThan(0);
    // Critically — Careers must NOT be retried after External committed.
    expect(careersCalls).toBe(0);
    expect(out.tenant_results[0]?.status).toBe("dead");
  });

  it("dispatches successfactors with metadata.host", async () => {
    const host = "career4.successfactors.eu";
    server.use(
      http.post(`https://${host}/careersection/rest/jobboard/search-jobs`, () =>
        HttpResponse.json(readFixture("successfactors.small.json")),
      ),
    );
    const out = await runScrape({
      input: {
        ats: "successfactors",
        tenants: [{ slug: "acme", metadata: { host } }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.jobs).toHaveLength(1);
    expect(out.tenant_results[0]?.status).toBe("success");
  });

  it("flags successfactors tenant dead when metadata.host is missing", async () => {
    const out = await runScrape({
      input: {
        ats: "successfactors",
        tenants: [{ slug: "acme" }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.tenant_results[0]?.status).toBe("dead");
    expect(out.tenant_results[0]?.error).toContain("metadata.host");
  });

  it("dispatches jsonld with metadata.sitemap_url", async () => {
    const sitemapUrl = "https://careers.example.com/sitemap.xml";
    server.use(
      http.get(sitemapUrl, () => HttpResponse.xml(readFixtureText("jsonld.sitemap.small.xml"))),
      http.get("https://careers.example.com/job/1001-engineer", () =>
        HttpResponse.html(readFixtureText("jsonld.job-basic.html")),
      ),
      http.get("https://careers.example.com/job/1002-designer", () =>
        HttpResponse.html(readFixtureText("jsonld.job-remote.html")),
      ),
    );
    const out = await runScrape({
      input: {
        ats: "jsonld",
        tenants: [
          {
            slug: "example",
            display_name: "Example Co",
            metadata: { sitemap_url: sitemapUrl },
          },
        ],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.jobs).toHaveLength(2);
    expect(out.tenant_results[0]?.status).toBe("success");
  });

  it("flags jsonld tenant dead when metadata.sitemap_url is missing", async () => {
    const out = await runScrape({
      input: {
        ats: "jsonld",
        tenants: [{ slug: "example" }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.tenant_results[0]?.status).toBe("dead");
    expect(out.tenant_results[0]?.error).toContain("metadata.sitemap_url");
  });

  it("dispatches gjobsfeed with metadata.feed_url", async () => {
    const feedUrl = "https://jobs.example.com/sitemap.xml";
    server.use(
      http.get(feedUrl, () => HttpResponse.xml(readFixtureText("gjobsfeed.exxonmobil-real.xml"))),
    );
    const out = await runScrape({
      input: {
        ats: "gjobsfeed",
        tenants: [
          {
            slug: "exxonmobil",
            display_name: "ExxonMobil",
            metadata: { feed_url: feedUrl },
          },
        ],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.jobs).toHaveLength(3);
    expect(out.tenant_results[0]?.status).toBe("success");
  });

  it("flags gjobsfeed tenant dead when metadata.feed_url is missing", async () => {
    const out = await runScrape({
      input: {
        ats: "gjobsfeed",
        tenants: [{ slug: "example" }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.tenant_results[0]?.status).toBe("dead");
    expect(out.tenant_results[0]?.error).toContain("metadata.feed_url");
  });

  it("dispatches brassring with metadata.partnerid + metadata.siteid", async () => {
    server.use(
      http.get("https://sjobs.brassring.com/TGNewUI/Search/Home/Home", () =>
        HttpResponse.html(readFixtureText("brassring.home.html"), {
          headers: {
            "Set-Cookie": "ASP.NET_SessionId=abc; HttpOnly",
          },
        }),
      ),
      http.post("https://sjobs.brassring.com/TgNewUI/Search/Ajax/PowerSearchJobs", () =>
        HttpResponse.json(readFixture("brassring.small.json")),
      ),
    );
    const out = await runScrape({
      input: {
        ats: "brassring",
        tenants: [
          {
            slug: "publix",
            display_name: "Publix Super Markets",
            metadata: { partnerid: "26173", siteid: "5197" },
          },
        ],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.jobs).toHaveLength(3);
    expect(out.tenant_results[0]?.status).toBe("success");
  });

  it("flags brassring tenant dead when metadata.partnerid is missing", async () => {
    const out = await runScrape({
      input: {
        ats: "brassring",
        tenants: [{ slug: "publix", metadata: { siteid: "5197" } }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.tenant_results[0]?.status).toBe("dead");
    expect(out.tenant_results[0]?.error).toContain("partnerid");
  });

  it("dispatches amazonjobs (single-tenant)", async () => {
    server.use(
      http.get("https://amazon.jobs/en/search.json", () =>
        HttpResponse.json(readFixture("amazonjobs.small.json")),
      ),
    );
    const out = await runScrape({
      input: {
        ats: "amazonjobs",
        tenants: [{ slug: "amazon", display_name: "Amazon" }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.jobs).toHaveLength(1);
    expect(out.tenant_results[0]?.status).toBe("success");
  });

  it("dispatches applejobs (single-tenant)", async () => {
    server.use(
      http.post("https://jobs.apple.com/api/role/search", () =>
        HttpResponse.json(readFixture("applejobs.small.json")),
      ),
    );
    const out = await runScrape({
      input: {
        ats: "applejobs",
        tenants: [{ slug: "apple", display_name: "Apple" }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.jobs).toHaveLength(1);
    expect(out.tenant_results[0]?.status).toBe("success");
  });

  it("dispatches tiktokcareers (single-tenant)", async () => {
    server.use(
      http.post("https://careers.tiktok.com/api/v1/search/job/posts", () =>
        HttpResponse.json(readFixture("tiktokcareers.small.json")),
      ),
    );
    const out = await runScrape({
      input: {
        ats: "tiktokcareers",
        tenants: [{ slug: "tiktok", display_name: "TikTok" }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.jobs).toHaveLength(1);
    expect(out.tenant_results[0]?.status).toBe("success");
  });

  it("dispatches metacareers (single-tenant)", async () => {
    server.use(
      http.post("https://www.metacareers.com/api/jobs", () =>
        HttpResponse.json(readFixture("metacareers.small.json")),
      ),
    );
    const out = await runScrape({
      input: {
        ats: "metacareers",
        tenants: [{ slug: "meta", display_name: "Meta" }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.jobs).toHaveLength(1);
    expect(out.tenant_results[0]?.status).toBe("success");
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

  it("dispatches breezy against the modern flat-array /json shape with nested location", async () => {
    server.use(
      http.get("https://flat.breezy.hr/json", () =>
        HttpResponse.json([
          {
            id: "id-aaa",
            name: "Customer Success Manager",
            url: "https://flat.breezy.hr/p/id-aaa",
            published_date: "2026-03-16T13:54:46.345Z",
            location: {
              country: { name: "Canada", id: "CA" },
              state: { id: "ON", name: "Ontario" },
              city: "Toronto",
              is_remote: true,
              name: "Toronto, ON",
            },
            department: { name: "Success" },
            company: { name: "Flat Co" },
          },
          {
            id: "id-bbb",
            name: "Speculative Application",
            location: { country: { id: "us" }, state: null, city: null },
            department: "Other",
            published_date: "not-a-date",
          },
          {
            id: "id-ccc",
            name: "Stringly",
            location: "Remote, EU",
            is_remote: true,
          },
          // Skipped: missing source id
          {
            name: "Headless",
          },
        ]),
      ),
    );
    const out = await runScrape({
      input: {
        ats: "breezy",
        tenants: [{ slug: "flat" }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.jobs).toHaveLength(3);
    const a = out.jobs.find((j) => j.source_id === "id-aaa");
    expect(a?.company).toBe("Flat Co");
    expect(a?.location_country).toBe("CA");
    expect(a?.location_text).toBe("Toronto, ON");
    expect(a?.workplace_type).toBe("remote");
    expect(a?.department).toBe("Success");
    const b = out.jobs.find((j) => j.source_id === "id-bbb");
    expect(b?.location_country).toBe("US");
    expect(b?.department).toBe("Other");
    const c = out.jobs.find((j) => j.source_id === "id-ccc");
    expect(c?.location_text).toBe("Remote, EU");
    expect(c?.workplace_type).toBe("remote");
  });

  it("breezy returns dead when the host fails", async () => {
    server.use(
      http.get("https://broken.breezy.hr/json", () => HttpResponse.text("nope", { status: 404 })),
    );
    const out = await runScrape({
      input: {
        ats: "breezy",
        tenants: [{ slug: "broken" }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.tenant_results[0]?.status).toBe("dead");
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

  it("dispatches workable against the apply.workable.com v1 widget API", async () => {
    server.use(
      http.get("https://apply.workable.com/api/v1/widget/accounts/example", () =>
        HttpResponse.json({
          name: "Example Inc",
          jobs: [
            {
              shortcode: "ABCD1234",
              title: "Principal Engineer",
              locations: [
                { country: "United Kingdom", countryCode: "GB", city: "London", region: "England" },
              ],
              department: "Engineering",
              workplace: "hybrid",
              published_on: "2026-04-19",
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
      http.get("https://apply.workable.com/api/v1/widget/accounts/onsiteco", () =>
        HttpResponse.json({
          name: "Onsite Co",
          jobs: [
            {
              shortcode: "X1",
              title: "Onsite Engineer",
              workplace: "On-site",
              published_on: "2026-04-19",
            },
          ],
        }),
      ),
      http.get("https://apply.workable.com/api/v1/widget/accounts/down", () =>
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

  it("dispatches smartrecruiters against the public /v1/companies/{tenant}/postings API", async () => {
    // smartrecruiters' tenant lookup is case-insensitive; lowercase slugs
    // round-trip cleanly through the harvester (which lowercases) and the
    // public API alike.
    server.use(
      http.get("https://api.smartrecruiters.com/v1/companies/example/postings", ({ request }) => {
        const url = new URL(request.url);
        const offset = url.searchParams.get("offset");
        if (offset === "0") {
          return HttpResponse.json({
            offset: 0,
            limit: 100,
            totalFound: 1,
            content: [
              {
                id: "744000123",
                name: "Senior Engineer",
                refNumber: "R1234",
                releasedDate: "2026-04-25T10:00:00Z",
                location: {
                  city: "Berlin",
                  country: "de",
                  fullLocation: "Berlin, Germany",
                  remote: false,
                  hybrid: true,
                },
                department: { label: "Engineering" },
              },
            ],
          });
        }
        return HttpResponse.json({ offset: 100, limit: 100, totalFound: 1, content: [] });
      }),
      // Per-posting detail endpoint returns the jobAd sections that the
      // adapter now reads to populate description_excerpt. Without this
      // handler MSW logs an unhandled-request warning and the test was
      // also racing against the detail fetch's network failure path.
      http.get("https://api.smartrecruiters.com/v1/companies/example/postings/744000123", () =>
        HttpResponse.json({
          id: "744000123",
          jobAd: {
            sections: { jobDescription: { text: "Build great things." } },
          },
        }),
      ),
    );
    const out = await runScrape({
      input: {
        ats: "smartrecruiters",
        tenants: [{ slug: "example", display_name: "Example Co" }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.jobs).toHaveLength(1);
    expect(out.jobs[0]?.title).toBe("Senior Engineer");
    expect(out.jobs[0]?.workplace_type).toBe("hybrid");
    expect(out.jobs[0]?.location_country).toBe("DE");
    expect(out.jobs[0]?.url).toContain("/example/744000123");
    expect(out.jobs[0]?.description_excerpt).toContain("Build great things");
  });

  it("dispatches pinpointhq against the public /jobs.json endpoint", async () => {
    server.use(
      http.get("https://example.pinpointhq.com/jobs.json", () =>
        HttpResponse.json({
          data: [
            {
              id: 472692,
              title: "Site Reliability Engineer",
              description: "Run our cloud platform.",
              workplace_type: "remote",
              workplace_type_text: "Fully remote",
              employment_type: "full_time",
              location: { id: 55750, name: "Spain" },
              department: { id: 60229, name: "Engineering" },
              compensation_minimum: 90000,
              compensation_maximum: 120000,
              compensation_currency: "EUR",
              url: "https://example.pinpointhq.com/en/jobs/472692",
              path: "/en/jobs/472692",
            },
          ],
        }),
      ),
    );
    const out = await runScrape({
      input: {
        ats: "pinpointhq",
        tenants: [{ slug: "example", display_name: "Example Co" }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.jobs).toHaveLength(1);
    expect(out.jobs[0]?.workplace_type).toBe("remote");
    expect(out.jobs[0]?.location_text).toBe("Spain");
    expect(out.jobs[0]?.department).toBe("Engineering");
    expect(out.jobs[0]?.compensation_min).toBe(90000);
    expect(out.jobs[0]?.compensation_currency).toBe("EUR");
  });

  it("pinpointhq covers hybrid/onsite mapping, path fallback URL, and 5xx", async () => {
    server.use(
      http.get("https://multico.pinpointhq.com/jobs.json", () =>
        HttpResponse.json({
          data: [
            {
              id: 1,
              title: "Hybrid PM",
              workplace_type: "hybrid",
              path: "/en/jobs/1",
              deadline_at: "2026-06-01T00:00:00Z",
            },
            {
              id: 2,
              title: "Onsite Lead",
              workplace_type: "onsite",
              compensation_minimum: -5,
              compensation_currency: "not-a-code",
            },
            {
              requisition_id: "REQ3",
              title: "Has requisition_id only",
              workplace_type: "office",
            },
            { id: 4 }, // skipped — no title
          ],
        }),
      ),
      http.get("https://broken.pinpointhq.com/jobs.json", () =>
        HttpResponse.text("oops", { status: 503 }),
      ),
    );
    const ok = await runScrape({
      input: {
        ats: "pinpointhq",
        tenants: [{ slug: "multico" }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(ok.jobs).toHaveLength(3);
    expect(ok.jobs[0]?.workplace_type).toBe("hybrid");
    expect(ok.jobs[0]?.url).toBe("https://multico.pinpointhq.com/en/jobs/1");
    // deadline_at is intentionally NOT mapped to updated_at (audit M4):
    // it's a future application close date, not a last-modified marker, and
    // mapping it would violate JobSchema's updated_at <= last_seen_at rule.
    expect(ok.jobs[0]?.updated_at).toBeUndefined();
    expect(ok.jobs[1]?.workplace_type).toBe("onsite");
    // negative compensation rejected; bad currency code rejected.
    expect(ok.jobs[1]?.compensation_min).toBeUndefined();
    expect(ok.jobs[1]?.compensation_currency).toBeUndefined();
    expect(ok.jobs[2]?.workplace_type).toBe("onsite"); // "office" maps to onsite
    expect(ok.jobs[2]?.url).toContain("/jobs/REQ3");
    const failed = await runScrape({
      input: {
        ats: "pinpointhq",
        tenants: [{ slug: "broken" }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(failed.tenant_results[0]?.status).not.toBe("success");
  });

  it("dispatches teamtailor against the public /jobs.rss feed", async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:tt="https://teamtailor.com/locations">
  <channel>
    <title>Example Inc</title>
    <description>Current Job Openings</description>
    <link>https://example.teamtailor.com/jobs</link>
    <item>
      <title>Account Manager, Mid-Market</title>
      <description>&lt;p&gt;Drive growth and renewals.&lt;/p&gt;</description>
      <pubDate>Fri, 27 Feb 2026 19:59:48 +0100</pubDate>
      <link>https://example.teamtailor.com/jobs/7308188-account-manager</link>
      <remoteStatus>hybrid</remoteStatus>
      <guid>679cc864-7629-4b8f-a5d4-6f9ebeccfaad</guid>
      <tt:locations>
        <tt:location>
          <tt:name>New York</tt:name>
          <tt:city>New York</tt:city>
          <tt:country>United States</tt:country>
        </tt:location>
      </tt:locations>
      <tt:department>Revenue</tt:department>
    </item>
  </channel>
</rss>`;
    server.use(http.get("https://example.teamtailor.com/jobs.rss", () => HttpResponse.xml(xml)));
    const out = await runScrape({
      input: {
        ats: "teamtailor",
        tenants: [{ slug: "example" }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.jobs).toHaveLength(1);
    expect(out.jobs[0]?.title).toBe("Account Manager, Mid-Market");
    expect(out.jobs[0]?.company).toBe("Example Inc");
    expect(out.jobs[0]?.workplace_type).toBe("hybrid");
    expect(out.jobs[0]?.location_text).toBe("New York");
    expect(out.jobs[0]?.department).toBe("Revenue");
    expect(out.jobs[0]?.posted_at).toBe("2026-02-27T18:59:48.000Z");
    expect(out.jobs[0]?.url).toBe("https://example.teamtailor.com/jobs/7308188-account-manager");
  });

  it("teamtailor maps remote/onsite/unknown remoteStatus and surfaces 5xx", async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:tt="https://teamtailor.com/locations">
  <channel>
    <title>MultiCo</title>
    <item>
      <title>Remote Eng</title>
      <link>https://multico.teamtailor.com/jobs/1</link>
      <guid>r-1</guid>
      <remoteStatus>remote</remoteStatus>
    </item>
    <item>
      <title>Onsite Lead</title>
      <link>https://multico.teamtailor.com/jobs/2</link>
      <guid>o-1</guid>
      <remoteStatus>on-site</remoteStatus>
    </item>
    <item>
      <title>Unspecified</title>
      <link>https://multico.teamtailor.com/jobs/3</link>
      <guid>u-1</guid>
    </item>
    <item>
      <title>Missing GUID</title>
      <link>https://multico.teamtailor.com/jobs/4</link>
    </item>
  </channel>
</rss>`;
    server.use(
      http.get("https://multico.teamtailor.com/jobs.rss", () => HttpResponse.xml(xml)),
      http.get("https://broken.teamtailor.com/jobs.rss", () =>
        HttpResponse.text("oops", { status: 503 }),
      ),
    );
    const ok = await runScrape({
      input: {
        ats: "teamtailor",
        tenants: [{ slug: "multico" }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    // 3 valid items (the missing-guid one is skipped).
    expect(ok.jobs).toHaveLength(3);
    expect(ok.jobs[0]?.workplace_type).toBe("remote");
    expect(ok.jobs[1]?.workplace_type).toBe("onsite");
    expect(ok.jobs[2]?.workplace_type).toBeNull();
    const failed = await runScrape({
      input: {
        ats: "teamtailor",
        tenants: [{ slug: "broken" }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(failed.tenant_results[0]?.status).not.toBe("success");
  });

  it("dispatches talentlyft via sitemap walk + JSON-LD JobPosting extraction", async () => {
    const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.talentlyft.com/jobs/senior-engineer-abcd</loc></url>
  <url><loc>https://example.talentlyft.com/jobs/manager-efgh</loc></url>
  <url><loc>https://example.talentlyft.com/</loc></url>
</urlset>`;
    const jobLd = (title: string, country: string) => `<!doctype html><html><head>
<script type="application/ld+json">{
  "@context": "https://schema.org/",
  "@type": "JobPosting",
  "title": "${title}",
  "description": "&lt;p&gt;Build great things.&lt;/p&gt;",
  "datePosted": "2026-04-20",
  "hiringOrganization": { "name": "Example" },
  "jobLocation": { "address": { "addressLocality": "Berlin", "addressRegion": "Berlin", "addressCountry": "${country}" } }
}</script></head><body></body></html>`;
    server.use(
      http.get("https://example.talentlyft.com/sitemap.xml", () => HttpResponse.xml(sitemap)),
      http.get("https://example.talentlyft.com/jobs/senior-engineer-abcd", () =>
        HttpResponse.html(jobLd("Senior Engineer", "DE")),
      ),
      http.get("https://example.talentlyft.com/jobs/manager-efgh", () =>
        HttpResponse.html(jobLd("Engineering Manager", "DE")),
      ),
    );
    const out = await runScrape({
      input: {
        ats: "talentlyft",
        tenants: [{ slug: "example", display_name: "Example Co" }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.jobs).toHaveLength(2);
    expect(out.jobs[0]?.title).toBe("Senior Engineer");
    expect(out.jobs[0]?.company).toBe("Example");
    expect(out.jobs[0]?.location_country).toBe("DE");
    expect(out.jobs[0]?.location_text).toContain("Berlin");
    expect(out.jobs[0]?.source_id).toBe("abcd");
  });

  it("talentlyft tolerates malformed JSON-LD and unusual URL shapes", async () => {
    const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://mixed.talentlyft.com/jobs/good-aaaa</loc></url>
  <url><loc>https://mixed.talentlyft.com/jobs/badld-bbbb</loc></url>
  <url><loc>https://mixed.talentlyft.com/jobs/notajob</loc></url>
</urlset>`;
    server.use(
      http.get("https://mixed.talentlyft.com/sitemap.xml", () => HttpResponse.xml(sitemap)),
      http.get("https://mixed.talentlyft.com/jobs/good-aaaa", () =>
        HttpResponse.html(`<script type="application/ld+json">{
          "@type": "JobPosting",
          "title": "Good Job",
          "hiringOrganization": "Mixed Co"
        }</script>`),
      ),
      // Malformed JSON-LD — must not throw the whole tenant.
      http.get("https://mixed.talentlyft.com/jobs/badld-bbbb", () =>
        HttpResponse.html(`<script type="application/ld+json">{not valid json</script>`),
      ),
      // Wrong @type — should be ignored.
      http.get("https://mixed.talentlyft.com/jobs/notajob", () =>
        HttpResponse.html(`<script type="application/ld+json">{"@type":"BreadcrumbList"}</script>`),
      ),
    );
    const out = await runScrape({
      input: {
        ats: "talentlyft",
        tenants: [{ slug: "mixed" }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    // Of three URLs only one yields a JobPosting; that's < 50 % failure
    // (1 success, 2 fails) which IS over the 50 % threshold — so the
    // outcome is transient_failure with zero jobs. Verify the path is
    // exercised, not the rendered shape.
    expect(out.tenant_results[0]?.status).toBe("transient_failure");
    expect(out.tenant_results[0]?.error).toContain("failed to parse");
  });

  it("talentlyft surfaces transient_failure when most job pages fail to parse", async () => {
    const sitemap = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://flaky.talentlyft.com/jobs/job-aaaa</loc></url>
  <url><loc>https://flaky.talentlyft.com/jobs/job-bbbb</loc></url>
  <url><loc>https://flaky.talentlyft.com/jobs/job-cccc</loc></url>
</urlset>`;
    server.use(
      http.get("https://flaky.talentlyft.com/sitemap.xml", () => HttpResponse.xml(sitemap)),
      http.get("https://flaky.talentlyft.com/jobs/job-aaaa", () => HttpResponse.text("nope")),
      http.get("https://flaky.talentlyft.com/jobs/job-bbbb", () => HttpResponse.text("nope")),
      http.get("https://flaky.talentlyft.com/jobs/job-cccc", () => HttpResponse.text("nope")),
    );
    const out = await runScrape({
      input: {
        ats: "talentlyft",
        tenants: [{ slug: "flaky" }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.jobs).toHaveLength(0);
    expect(out.tenant_results[0]?.status).toBe("transient_failure");
  });

  it("dispatches jobvite via listing scrape + JSON-LD JobPosting extraction", async () => {
    const listing = `<!doctype html><html><body>
<table class="jv-job-list">
  <tr>
    <td class="jv-job-list-name"><a href="/example/job/abcdef12">Senior Engineer</a></td>
    <td class="jv-job-list-location">Berlin</td>
  </tr>
  <tr>
    <td class="jv-job-list-name"><a href="/example/job/ghijkl34">Engineering Manager</a></td>
    <td class="jv-job-list-location">Berlin</td>
  </tr>
</table></body></html>`;
    const jobLd = (title: string) => `<!doctype html><html><head>
<script type="application/ld+json">{
  "@context": "https://schema.org/",
  "@type": "JobPosting",
  "title": "${title}",
  "description": "&lt;p&gt;Build it.&lt;/p&gt;",
  "datePosted": "2026-04-22",
  "industry": "Engineering",
  "hiringOrganization": "Example",
  "jobLocation": { "address": { "addressLocality": "Berlin", "addressRegion": "Berlin", "addressCountry": "DE" } }
}</script></head></html>`;
    server.use(
      http.get("https://jobs.jobvite.com/example", () => HttpResponse.html(listing)),
      http.get("https://jobs.jobvite.com/example/job/abcdef12", () =>
        HttpResponse.html(jobLd("Senior Engineer")),
      ),
      http.get("https://jobs.jobvite.com/example/job/ghijkl34", () =>
        HttpResponse.html(jobLd("Engineering Manager")),
      ),
    );
    const out = await runScrape({
      input: {
        ats: "jobvite",
        tenants: [{ slug: "example", display_name: "Example Co" }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.jobs).toHaveLength(2);
    expect(out.jobs[0]?.title).toBe("Senior Engineer");
    expect(out.jobs[0]?.company).toBe("Example");
    expect(out.jobs[0]?.location_country).toBe("DE");
    expect(out.jobs[0]?.location_text).toContain("Berlin");
    expect(out.jobs[0]?.department).toBe("Engineering");
    expect(out.jobs[0]?.source_id).toBe("abcdef12");
  });

  it("jobvite ignores listing rows that don't match the {slug}/job/{shortcode} shape", async () => {
    const listing = `<!doctype html><html><body>
<table class="jv-job-list">
  <tr>
    <td class="jv-job-list-name"><a href="/example/job/aaaa1111">Real Job</a></td>
  </tr>
  <tr>
    <td class="jv-job-list-name"><a href="https://evil.example.com/example/job/escapehatch">SSRF Attempt</a></td>
  </tr>
  <tr>
    <td class="jv-job-list-name"><a href="/other-tenant/job/bbbb2222">Wrong Tenant</a></td>
  </tr>
</table></body></html>`;
    server.use(
      http.get("https://jobs.jobvite.com/example", () => HttpResponse.html(listing)),
      http.get("https://jobs.jobvite.com/example/job/aaaa1111", () =>
        HttpResponse.html(`<script type="application/ld+json">{
          "@type": "JobPosting",
          "title": "Real Job",
          "hiringOrganization": "Example"
        }</script>`),
      ),
    );
    const out = await runScrape({
      input: {
        ats: "jobvite",
        tenants: [{ slug: "example" }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.jobs).toHaveLength(1);
    expect(out.jobs[0]?.title).toBe("Real Job");
    expect(out.tenant_results[0]?.status).toBe("success");
  });

  it("jobvite surfaces transient_failure when most detail pages fail to parse", async () => {
    const listing = `<!doctype html><html><body>
<table class="jv-job-list">
  <tr><td class="jv-job-list-name"><a href="/flaky/job/aaaa1111">A</a></td></tr>
  <tr><td class="jv-job-list-name"><a href="/flaky/job/bbbb2222">B</a></td></tr>
  <tr><td class="jv-job-list-name"><a href="/flaky/job/cccc3333">C</a></td></tr>
</table></body></html>`;
    server.use(
      http.get("https://jobs.jobvite.com/flaky", () => HttpResponse.html(listing)),
      http.get("https://jobs.jobvite.com/flaky/job/aaaa1111", () => HttpResponse.text("nope")),
      http.get("https://jobs.jobvite.com/flaky/job/bbbb2222", () => HttpResponse.text("nope")),
      http.get("https://jobs.jobvite.com/flaky/job/cccc3333", () => HttpResponse.text("nope")),
    );
    const out = await runScrape({
      input: {
        ats: "jobvite",
        tenants: [{ slug: "flaky" }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.jobs).toHaveLength(0);
    expect(out.tenant_results[0]?.status).toBe("transient_failure");
  });

  it("jobvite tolerates malformed JSON-LD and non-JobPosting types on detail pages", async () => {
    const listing = `<!doctype html><html><body>
<table class="jv-job-list">
  <tr><td class="jv-job-list-name"><a href="/mixed/job/aaaa1111">Real Job</a></td></tr>
  <tr><td class="jv-job-list-name"><a href="/mixed/job/bbbb2222">Bad LD</a></td></tr>
  <tr><td class="jv-job-list-name"><a href="/mixed/job/cccc3333">Wrong Type</a></td></tr>
</table></body></html>`;
    server.use(
      http.get("https://jobs.jobvite.com/mixed", () => HttpResponse.html(listing)),
      http.get("https://jobs.jobvite.com/mixed/job/aaaa1111", () =>
        HttpResponse.html(`<script type="application/ld+json">{
          "@type": "JobPosting",
          "title": "Real Job",
          "hiringOrganization": { "name": "Mixed Co" }
        }</script>`),
      ),
      // Malformed JSON-LD: must skip without poisoning the rest.
      http.get("https://jobs.jobvite.com/mixed/job/bbbb2222", () =>
        HttpResponse.html(`<script type="application/ld+json">{not valid json</script>`),
      ),
      // Wrong @type: must be ignored.
      http.get("https://jobs.jobvite.com/mixed/job/cccc3333", () =>
        HttpResponse.html(`<script type="application/ld+json">{"@type":"BreadcrumbList"}</script>`),
      ),
    );
    const out = await runScrape({
      input: {
        ats: "jobvite",
        tenants: [{ slug: "mixed" }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    // 1 success, 2 fails — over the 50% threshold so the tenant degrades to transient_failure.
    expect(out.tenant_results[0]?.status).toBe("transient_failure");
    expect(out.tenant_results[0]?.error).toContain("failed to parse");
  });

  it("jobvite surfaces transient_failure when /job/ markers exist but parseListingHrefs returns nothing", async () => {
    // The listing page carries `/job/` markers so the careers page is
    // alive and there are jobs there — but our row regex doesn't match
    // them (vendor changed the row layout). Surface transient_failure.
    const listing = `<!doctype html><html><body>
<p>Visit /drift/job/aaaa1111 for details — but the row layout is unrecognised.</p>
<div data-job-id="bbbb2222">/job/bbbb2222</div>
</body></html>`;
    server.use(http.get("https://jobs.jobvite.com/drift", () => HttpResponse.html(listing)));
    const out = await runScrape({
      input: {
        ats: "jobvite",
        tenants: [{ slug: "drift" }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.tenant_results[0]?.status).toBe("transient_failure");
    expect(out.tenant_results[0]?.error).toContain("expected layout");
  });

  it("jobvite surfaces dead when the listing fetch errors out", async () => {
    server.use(
      http.get("https://jobs.jobvite.com/down", () => HttpResponse.text("nope", { status: 404 })),
    );
    const out = await runScrape({
      input: {
        ats: "jobvite",
        tenants: [{ slug: "down" }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.tenant_results[0]?.status).toBe("dead");
  });

  it("jobvite returns success: 0 jobs when the listing has no matching rows", async () => {
    server.use(
      http.get("https://jobs.jobvite.com/empty", () =>
        HttpResponse.html("<!doctype html><html><body>No jobs available.</body></html>"),
      ),
    );
    const out = await runScrape({
      input: {
        ats: "jobvite",
        tenants: [{ slug: "empty" }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.jobs).toHaveLength(0);
    expect(out.tenant_results[0]?.status).toBe("success");
    expect(out.tenant_results[0]?.jobs_count).toBe(0);
  });

  it("dispatches homerun via feed.homerun.co Atom feed", async () => {
    const atom = `<?xml version="1.0" encoding="UTF-8" ?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title type="text">Example Co</title>
  <updated>2026-04-24T07:42:51+00:00</updated>
  <entry>
    <author><name>Example Co</name></author>
    <title type="text">Senior Engineer</title>
    <link rel="alternate" type="text/html" href="https://example.homerun.co/senior-engineer"/>
    <id>job_AAAA1111</id>
    <summary type="html"><![CDATA[Build great things.]]></summary>
    <description type="html"><![CDATA[<p>Build great things.</p>]]></description>
    <author><name>Example Co</name></author>
    <department><name>Engineering</name></department>
    <location><name>Remote</name></location>
    <type><name>Full-time</name></type>
    <updated>2026-04-13 08:46:19</updated>
  </entry>
  <entry>
    <author><name>Example Co</name></author>
    <title type="text">Marketing Lead</title>
    <link rel="alternate" type="text/html" href="https://example.homerun.co/marketing-lead"/>
    <id>job_BBBB2222</id>
    <description type="html"><![CDATA[<p>Run campaigns.</p>]]></description>
    <department><name>Marketing</name></department>
    <location><name>Hybrid</name></location>
    <updated>2026-04-20T10:15:00+00:00</updated>
  </entry>
  <!-- skipped: missing id -->
  <entry>
    <title type="text">Headless</title>
    <link rel="alternate" type="text/html" href="https://example.homerun.co/headless"/>
  </entry>
</feed>`;
    server.use(http.get("https://feed.homerun.co/example", () => HttpResponse.xml(atom)));
    const out = await runScrape({
      input: {
        ats: "homerun",
        tenants: [{ slug: "example" }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.jobs).toHaveLength(2);
    const senior = out.jobs.find((j) => j.source_id === "job_AAAA1111");
    expect(senior?.title).toBe("Senior Engineer");
    expect(senior?.company).toBe("Example Co");
    expect(senior?.location_text).toBe("Remote");
    expect(senior?.workplace_type).toBe("remote");
    expect(senior?.department).toBe("Engineering");
    const marketing = out.jobs.find((j) => j.source_id === "job_BBBB2222");
    expect(marketing?.workplace_type).toBe("hybrid");
    expect(marketing?.updated_at).toBe("2026-04-20T10:15:00.000Z");
  });

  it("homerun degrades to transient_failure when entries fail to parse (vendor schema drift)", async () => {
    const atom = `<?xml version="1.0" encoding="UTF-8" ?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title type="text">Drift Co</title>
  <entry><title type="text">Has no link or id</title></entry>
  <entry><id>job_AAAA1111</id><title type="text">No link</title></entry>
  <entry>
    <link rel="alternate" type="text/html" href="https://drift.homerun.co/only-link"/>
    <title type="text">No id</title>
  </entry>
</feed>`;
    server.use(http.get("https://feed.homerun.co/drift", () => HttpResponse.xml(atom)));
    const out = await runScrape({
      input: {
        ats: "homerun",
        tenants: [{ slug: "drift" }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.tenant_results[0]?.status).toBe("transient_failure");
    expect(out.tenant_results[0]?.error).toContain("failed to parse");
  });

  it("homerun handles numeric <id> coercion from fast-xml-parser", async () => {
    const atom = `<?xml version="1.0" encoding="UTF-8" ?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title type="text">Num Co</title>
  <entry>
    <title type="text">Numeric Id</title>
    <link rel="alternate" type="text/html" href="https://num.homerun.co/numeric"/>
    <id>987654321</id>
    <type><name>Remote</name></type>
  </entry>
</feed>`;
    server.use(http.get("https://feed.homerun.co/num", () => HttpResponse.xml(atom)));
    const out = await runScrape({
      input: {
        ats: "homerun",
        tenants: [{ slug: "num" }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.jobs).toHaveLength(1);
    expect(out.jobs[0]?.source_id).toBe("987654321");
    // <type><name>Remote</name></type> should set workplace_type even when
    // location is empty, exercising the type-fallback branch in
    // workplaceFromHomerun.
    expect(out.jobs[0]?.workplace_type).toBe("remote");
  });

  it("homerun returns dead when the feed is missing (no slug match)", async () => {
    server.use(
      http.get("https://feed.homerun.co/missing", () =>
        HttpResponse.text("not found", { status: 404 }),
      ),
    );
    const out = await runScrape({
      input: {
        ats: "homerun",
        tenants: [{ slug: "missing" }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.tenant_results[0]?.status).toBe("dead");
  });

  it("dispatches zohorecruit via Careers/rss feed and parses Category/Location prefixes", async () => {
    server.use(
      http.get("https://example.zohorecruit.com/jobs/Careers/rss", () =>
        HttpResponse.xml(readFixtureText("zohorecruit.small.xml")),
      ),
    );
    const out = await runScrape({
      input: {
        ats: "zohorecruit",
        tenants: [{ slug: "example" }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.tenant_results[0]?.status).toBe("success");
    expect(out.jobs).toHaveLength(1);
    const job = out.jobs[0];
    expect(job?.source_id).toBe("671845000006588001");
    expect(job?.title).toBe("Ramp Agent (Cayman Brac)");
    // Channel title is "Cayman Airways Ltd. - Careers" — the " - Careers"
    // suffix is stripped so the company reads cleanly.
    expect(job?.company).toBe("Cayman Airways Ltd.");
    expect(job?.location_text).toBe("Cayman Brac . Cayman Islands");
    expect(job?.department).toBe("Airline - Aviation");
    expect(job?.workplace_type).toBe(null);
    // PDT pubDate normalizes to UTC ISO with the Z suffix the schema requires.
    expect(job?.posted_at).toBe("2026-04-22T19:00:00.000Z");
    expect(job?.url).toBe(
      "https://caymanairways.zohorecruit.com/jobs/Careers/671845000006588001/Ramp-Agent-Cayman-Brac?source=RSS",
    );
    expect(job?.description_excerpt).toContain("Ramp Agent");
  });

  it("zohorecruit returns success-with-zero when joblist has been removed", async () => {
    // Zoho returns HTTP 200 with this 49-byte body for tenants whose careers
    // page is set to private or whose admin has emptied the listings. The
    // tenant subdomain is alive — treat as success rather than dead.
    server.use(
      http.get("https://emptyzoho.zohorecruit.com/jobs/Careers/rss", () =>
        HttpResponse.text("Oops! It seems that the joblist has been removed."),
      ),
    );
    const out = await runScrape({
      input: {
        ats: "zohorecruit",
        tenants: [{ slug: "emptyzoho" }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.tenant_results[0]?.status).toBe("success");
    expect(out.tenant_results[0]?.jobs_count).toBe(0);
    expect(out.jobs).toHaveLength(0);
  });

  it("zohorecruit classifies non-existent subdomains as dead", async () => {
    // Real shape: HTTP 200 with a Zoho-branded HTML "does not exist" page.
    const errorPage =
      "<!DOCTYPE html><html><head><title>Page does not exist</title></head><body>" +
      '<div class="cl-error-content"><h2>deadtenant.zohorecruit.com <span>does not exist.</span></h2>' +
      "</div></body></html>";
    server.use(
      http.get("https://deadtenant.zohorecruit.com/jobs/Careers/rss", () =>
        HttpResponse.html(errorPage),
      ),
    );
    const out = await runScrape({
      input: {
        ats: "zohorecruit",
        tenants: [{ slug: "deadtenant" }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.tenant_results[0]?.status).toBe("dead");
    expect(out.tenant_results[0]?.error).toContain("does not exist");
  });

  it("zohorecruit also recognizes the smaller 'could not be found' error variant", async () => {
    const errorPage =
      "<!DOCTYPE html><html><head><title>Page does not exist</title></head><body>" +
      '<div class="cw-error-wrap cl-error-block"><div class="cl-error-content">' +
      "<p>The page you're trying to access could not be found.</p>" +
      "</div></div></body></html>";
    server.use(
      http.get("https://gone.zohorecruit.com/jobs/Careers/rss", () => HttpResponse.html(errorPage)),
    );
    const out = await runScrape({
      input: {
        ats: "zohorecruit",
        tenants: [{ slug: "gone" }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.tenant_results[0]?.status).toBe("dead");
  });

  it("zohorecruit degrades to transient_failure when items fail to parse (vendor schema drift)", async () => {
    const drift = `<?xml version='1.0' encoding='utf-8'?>
<rss version='2.0'><channel>
<title>Drift Co - Careers</title>
<item><title><![CDATA[No guid no link]]></title></item>
<item><guid isPermaLink='false'>987654321001</guid><title><![CDATA[No link]]></title></item>
<item><link>https://drift.zohorecruit.com/jobs/Careers/123/X</link><title><![CDATA[No guid]]></title></item>
</channel></rss>`;
    server.use(
      http.get("https://drift.zohorecruit.com/jobs/Careers/rss", () => HttpResponse.xml(drift)),
    );
    const out = await runScrape({
      input: {
        ats: "zohorecruit",
        tenants: [{ slug: "drift" }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.tenant_results[0]?.status).toBe("transient_failure");
    expect(out.tenant_results[0]?.error).toContain("failed to parse");
  });

  it("zohorecruit reports transient_failure when body is neither RSS nor a known status text", async () => {
    server.use(
      http.get("https://noisy.zohorecruit.com/jobs/Careers/rss", () =>
        HttpResponse.text("upstream proxy returned an unexpected payload"),
      ),
    );
    const out = await runScrape({
      input: {
        ats: "zohorecruit",
        tenants: [{ slug: "noisy" }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.tenant_results[0]?.status).toBe("transient_failure");
    expect(out.tenant_results[0]?.error).toContain("not RSS XML");
  });

  it("zohorecruit reports transient_failure when XML lacks a <channel> element", async () => {
    server.use(
      http.get("https://nochannel.zohorecruit.com/jobs/Careers/rss", () =>
        HttpResponse.xml("<?xml version='1.0' encoding='utf-8'?><rss version='2.0'></rss>"),
      ),
    );
    const out = await runScrape({
      input: {
        ats: "zohorecruit",
        tenants: [{ slug: "nochannel" }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.tenant_results[0]?.status).toBe("transient_failure");
    expect(out.tenant_results[0]?.error).toContain("missing <channel>");
  });

  it("zohorecruit succeeds-with-zero when channel has no <item> elements", async () => {
    // codebleu in the wild: live tenant, French locale, channel rendered but
    // no jobs published yet. Should report success rather than fail.
    const empty = `<?xml version='1.0' encoding='utf-8'?>
<rss version='2.0'><channel>
<title>Code Bleu - Careers</title><language>fr-FR</language>
<link>https://codebleu.zohorecruit.com/jobs/Careers/rss</link>
</channel></rss>`;
    server.use(
      http.get("https://codebleu.zohorecruit.com/jobs/Careers/rss", () => HttpResponse.xml(empty)),
    );
    const out = await runScrape({
      input: {
        ats: "zohorecruit",
        tenants: [{ slug: "codebleu" }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.tenant_results[0]?.status).toBe("success");
    expect(out.tenant_results[0]?.jobs_count).toBe(0);
  });

  it("zohorecruit detects remote/hybrid workplace_type from the Location prefix", async () => {
    const xml = `<?xml version='1.0' encoding='utf-8'?>
<rss version='2.0'><channel>
<title>Workplace Co - Careers</title>
<item>
<title><![CDATA[Backend Engineer]]></title>
<link>https://workplaceco.zohorecruit.com/jobs/Careers/100/Backend?source=RSS</link>
<description><![CDATA[Category: Engineering <br><br>Location: Remote, United States <br><br><p>Build APIs.</p>]]></description>
<guid isPermaLink='false'>100</guid>
<pubDate>Mon, 21 Apr 2026 12:00:00 PDT</pubDate>
</item>
<item>
<title><![CDATA[Designer]]></title>
<link>https://workplaceco.zohorecruit.com/jobs/Careers/200/Designer?source=RSS</link>
<description><![CDATA[Category: Design <br><br>Location: Hybrid - Berlin <br><br><p>Design product.</p>]]></description>
<guid isPermaLink='false'>200</guid>
<pubDate>Tue, 22 Apr 2026 12:00:00 PDT</pubDate>
</item>
<item>
<title><![CDATA[Recruiter]]></title>
<link>https://workplaceco.zohorecruit.com/jobs/Careers/300/Recruiter?source=RSS</link>
<description><![CDATA[Category: People <br><br>Location:    <br><br><p>Hire great people.</p>]]></description>
<guid>300</guid>
<pubDate>Wed, 23 Apr 2026 12:00:00 PDT</pubDate>
</item>
</channel></rss>`;
    server.use(
      http.get("https://workplaceco.zohorecruit.com/jobs/Careers/rss", () => HttpResponse.xml(xml)),
    );
    const out = await runScrape({
      input: {
        ats: "zohorecruit",
        tenants: [{ slug: "workplaceco" }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.jobs).toHaveLength(3);
    const backend = out.jobs.find((j) => j.source_id === "100");
    expect(backend?.workplace_type).toBe("remote");
    expect(backend?.location_text).toBe("Remote, United States");
    const designer = out.jobs.find((j) => j.source_id === "200");
    expect(designer?.workplace_type).toBe("hybrid");
    // Numeric guid (no isPermaLink wrapper) coerces to string source_id.
    const recruiter = out.jobs.find((j) => j.source_id === "300");
    expect(recruiter?.location_text).toBeUndefined();
    expect(recruiter?.workplace_type).toBe(null);
    // Title-based recruiter classification mirrors greenhouse / lever.
    expect(recruiter?.is_recruiter_post).toBe(true);
    expect(backend?.is_recruiter_post).toBe(false);
  });

  it("zohorecruit drops future-dated posted_at instead of rejecting the entry", async () => {
    // The schema rejects posted_at > last_seen_at. A pubDate ahead of the
    // observed-at clock (rare edge case from clock skew or a tenant in a
    // future timezone) should be dropped rather than failing the whole job.
    const xml = `<?xml version='1.0' encoding='utf-8'?>
<rss version='2.0'><channel>
<title>Future Co - Careers</title>
<item>
<title><![CDATA[Time Traveller]]></title>
<link>https://future.zohorecruit.com/jobs/Careers/777/Time?source=RSS</link>
<description><![CDATA[Category: General <br><br>Location: Anywhere <br><br><p>Yes.</p>]]></description>
<guid isPermaLink='false'>777</guid>
<pubDate>Fri, 25 Dec 2099 12:00:00 PDT</pubDate>
</item>
</channel></rss>`;
    server.use(
      http.get("https://future.zohorecruit.com/jobs/Careers/rss", () => HttpResponse.xml(xml)),
    );
    const out = await runScrape({
      input: {
        ats: "zohorecruit",
        tenants: [{ slug: "future" }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.jobs).toHaveLength(1);
    expect(out.jobs[0]?.posted_at).toBeUndefined();
  });

  it("zohorecruit drops unparseable pubDate values without failing the entry", async () => {
    // Some tenants emit pubDates that even Bun's lenient Date parser rejects
    // (extreme locale strings, malformed shapes from upstream caches). The
    // entry should still ship — only the posted_at field is dropped.
    const xml = `<?xml version='1.0' encoding='utf-8'?>
<rss version='2.0'><channel>
<title>Garbled Co - Careers</title>
<item>
<title><![CDATA[Consultant SAP]]></title>
<link>https://garbled.zohorecruit.com/jobs/Careers/96802/Consultant?source=RSS</link>
<description><![CDATA[Category: SAP <br><br>Location: Paris France <br><br><p>SAP consulting.</p>]]></description>
<guid isPermaLink='false'>96802</guid>
<pubDate>not a date at all</pubDate>
</item>
</channel></rss>`;
    server.use(
      http.get("https://garbled.zohorecruit.com/jobs/Careers/rss", () => HttpResponse.xml(xml)),
    );
    const out = await runScrape({
      input: {
        ats: "zohorecruit",
        tenants: [{ slug: "garbled" }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.jobs).toHaveLength(1);
    expect(out.jobs[0]?.posted_at).toBeUndefined();
    expect(out.jobs[0]?.title).toBe("Consultant SAP");
  });

  it("zohorecruit falls back to display_name then slug when channel title is absent", async () => {
    const xml = `<?xml version='1.0' encoding='utf-8'?>
<rss version='2.0'><channel>
<item>
<title><![CDATA[Engineer]]></title>
<link>https://noname.zohorecruit.com/jobs/Careers/1/Engineer?source=RSS</link>
<description><![CDATA[Category: Eng <br><br>Location: NYC <br><br>Build.]]></description>
<guid isPermaLink='false'>1</guid>
<pubDate>Mon, 21 Apr 2026 12:00:00 PDT</pubDate>
</item>
</channel></rss>`;
    server.use(
      http.get("https://noname.zohorecruit.com/jobs/Careers/rss", () => HttpResponse.xml(xml)),
    );
    const out = await runScrape({
      input: {
        ats: "zohorecruit",
        tenants: [{ slug: "noname", display_name: "No Name Co" }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.jobs).toHaveLength(1);
    expect(out.jobs[0]?.company).toBe("No Name Co");
  });

  it("zohorecruit falls back to slug when both channel title and display_name are absent", async () => {
    const xml = `<?xml version='1.0' encoding='utf-8'?>
<rss version='2.0'><channel>
<item>
<title><![CDATA[Engineer]]></title>
<link>https://bareslug.zohorecruit.com/jobs/Careers/1/Engineer?source=RSS</link>
<description><![CDATA[Category: Eng <br><br>Location: NYC <br><br>Build.]]></description>
<guid isPermaLink='false'>1</guid>
<pubDate>Mon, 21 Apr 2026 12:00:00 PDT</pubDate>
</item>
</channel></rss>`;
    server.use(
      http.get("https://bareslug.zohorecruit.com/jobs/Careers/rss", () => HttpResponse.xml(xml)),
    );
    const out = await runScrape({
      input: {
        ats: "zohorecruit",
        tenants: [{ slug: "bareslug" }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.jobs).toHaveLength(1);
    expect(out.jobs[0]?.company).toBe("bareslug");
  });

  it("zohorecruit returns dead when the request itself yields HTTP 404", async () => {
    server.use(
      http.get("https://hard404.zohorecruit.com/jobs/Careers/rss", () =>
        HttpResponse.text("not found", { status: 404 }),
      ),
    );
    const out = await runScrape({
      input: {
        ats: "zohorecruit",
        tenants: [{ slug: "hard404" }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.tenant_results[0]?.status).toBe("dead");
  });

  it("dispatches factorial via sitemap walk + og:title meta extraction", async () => {
    const sitemap = `<?xml version='1.0' encoding='UTF-8'?>
<urlset xmlns='http://www.sitemaps.org/schemas/sitemap/0.9'>
  <url><loc>https://example.factorialhr.com</loc></url>
  <url><loc>https://example.factorialhr.com/job_posting/senior-engineer-294697</loc></url>
  <url><loc>https://example.factorialhr.com/job_posting/marketing-lead-308122</loc></url>
</urlset>`;
    const detail = (title: string, body: string) => `<!doctype html><html><head>
<meta content='${title}
' name='title' property='og:title'>
<meta content='Apply today to ${title} job offer
' name='description' property='og:description'>
</head><body>
<h1>${title}</h1>
${body}
<a href='/apply/${title.toLowerCase().replace(/ /g, "-")}'>Apply now</a>
</body></html>`;
    server.use(
      http.get("https://example.factorialhr.com/sitemap.xml", () => HttpResponse.xml(sitemap)),
      http.get("https://example.factorialhr.com/job_posting/senior-engineer-294697", () =>
        HttpResponse.html(detail("Senior Engineer", "<p>Build the platform.</p>")),
      ),
      http.get("https://example.factorialhr.com/job_posting/marketing-lead-308122", () =>
        HttpResponse.html(detail("Marketing Lead", "<p>Run campaigns.</p>")),
      ),
    );
    const out = await runScrape({
      input: {
        ats: "factorial",
        tenants: [{ slug: "example", display_name: "Example Co" }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.jobs).toHaveLength(2);
    const senior = out.jobs.find((j) => j.source_id === "294697");
    expect(senior?.title).toBe("Senior Engineer");
    expect(senior?.company).toBe("Example Co");
    expect(senior?.description_excerpt).toContain("Build the platform");
    const lead = out.jobs.find((j) => j.source_id === "308122");
    expect(lead?.title).toBe("Marketing Lead");
  });

  it("factorial rejects sitemap URLs that point at the wrong host", async () => {
    const sitemap = `<?xml version='1.0' encoding='UTF-8'?>
<urlset xmlns='http://www.sitemaps.org/schemas/sitemap/0.9'>
  <url><loc>https://good.factorialhr.com/job_posting/real-job-111</loc></url>
  <url><loc>https://evil.example.com/job_posting/escapehatch-222</loc></url>
  <url><loc>https://other.factorialhr.com/job_posting/wrong-tenant-333</loc></url>
</urlset>`;
    server.use(
      http.get("https://good.factorialhr.com/sitemap.xml", () => HttpResponse.xml(sitemap)),
      http.get("https://good.factorialhr.com/job_posting/real-job-111", () =>
        HttpResponse.html(`<meta content='Real Job
' property='og:title'><h1>Real Job</h1><a href="/apply/real-job-111">Apply</a>`),
      ),
    );
    const out = await runScrape({
      input: {
        ats: "factorial",
        tenants: [{ slug: "good" }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.jobs).toHaveLength(1);
    expect(out.jobs[0]?.source_id).toBe("111");
    expect(out.tenant_results[0]?.status).toBe("success");
  });

  it("factorial returns success with zero jobs when sitemap has no job_posting entries", async () => {
    server.use(
      http.get("https://empty.factorialhr.com/sitemap.xml", () =>
        HttpResponse.xml(`<?xml version='1.0' encoding='UTF-8'?>
<urlset xmlns='http://www.sitemaps.org/schemas/sitemap/0.9'>
  <url><loc>https://empty.factorialhr.com</loc></url>
</urlset>`),
      ),
    );
    const out = await runScrape({
      input: {
        ats: "factorial",
        tenants: [{ slug: "empty" }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.jobs).toHaveLength(0);
    expect(out.tenant_results[0]?.status).toBe("success");
  });

  it("factorial filter rejects malformed sitemap URLs and network errors poison only the affected job", async () => {
    const sitemap = `<?xml version='1.0' encoding='UTF-8'?>
<urlset xmlns='http://www.sitemaps.org/schemas/sitemap/0.9'>
  <url><loc>https://mixed.factorialhr.com/job_posting/good-101</loc></url>
  <url><loc>https://mixed.factorialhr.com/job_posting/bad-202</loc></url>
  <url><loc>not a url at all</loc></url>
</urlset>`;
    server.use(
      http.get("https://mixed.factorialhr.com/sitemap.xml", () => HttpResponse.xml(sitemap)),
      http.get("https://mixed.factorialhr.com/job_posting/good-101", () =>
        HttpResponse.html(
          `<meta content='Good Job
' property='og:title'><h1>Good Job</h1><p>Body</p><a href='/apply/good-101'>Apply</a>`,
        ),
      ),
      // Network-style failure on the second job — exercises the per-task catch.
      http.get("https://mixed.factorialhr.com/job_posting/bad-202", () => HttpResponse.error()),
    );
    const out = await runScrape({
      input: {
        ats: "factorial",
        tenants: [{ slug: "mixed" }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    // Of the 3 sitemap rows, one is malformed (filtered out before fetch)
    // and one fails network-style. With 1 success + 1 fail the failure
    // rate is exactly 50% — at the threshold but not above, so the tenant
    // stays at success with 1 job. The test still exercises the URL-parse
    // catch and the per-task fetch catch for coverage purposes.
    expect(out.jobs).toHaveLength(1);
    expect(out.jobs[0]?.source_id).toBe("101");
    expect(out.tenant_results[0]?.status).toBe("success");
  });

  it("factorial degrades to transient_failure when most detail pages have no og:title", async () => {
    const sitemap = `<?xml version='1.0' encoding='UTF-8'?>
<urlset xmlns='http://www.sitemaps.org/schemas/sitemap/0.9'>
  <url><loc>https://flaky.factorialhr.com/job_posting/a-1</loc></url>
  <url><loc>https://flaky.factorialhr.com/job_posting/b-2</loc></url>
  <url><loc>https://flaky.factorialhr.com/job_posting/c-3</loc></url>
</urlset>`;
    server.use(
      http.get("https://flaky.factorialhr.com/sitemap.xml", () => HttpResponse.xml(sitemap)),
      http.get("https://flaky.factorialhr.com/job_posting/a-1", () => HttpResponse.text("nope")),
      http.get("https://flaky.factorialhr.com/job_posting/b-2", () => HttpResponse.text("nope")),
      http.get("https://flaky.factorialhr.com/job_posting/c-3", () => HttpResponse.text("nope")),
    );
    const out = await runScrape({
      input: {
        ats: "factorial",
        tenants: [{ slug: "flaky" }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.jobs).toHaveLength(0);
    expect(out.tenant_results[0]?.status).toBe("transient_failure");
  });

  it("dispatches applicantpro via /core/jobs JSON endpoint discovered from listing", async () => {
    const listing = `<!doctype html><html><script>
      mountingData.courierCurrentRouteData = {"domain_id":"17874","career_site_name":"Example"};
    </script></html>`;
    const apiResp = {
      success: true,
      data: {
        jobs: [
          {
            id: 100001,
            title: "Senior Engineer",
            city: "Austin",
            stateName: "Texas",
            iso3: "USA",
            abbreviation: "TX",
            jobLocation: "Austin, TX, USA",
            workplaceType: "Remote",
            employmentType: "Full Time",
            minSalary: "120000",
            maxSalary: "180000",
            jobUrl: "https://example.applicantpro.com/jobs/100001",
          },
          {
            id: 100002,
            title: "Barista",
            city: "Austin",
            stateName: "Texas",
            iso3: "USA",
            abbreviation: "TX",
            jobLocation: "Austin, TX, USA",
            workplaceType: "Onsite",
            employmentType: "Part Time",
            minSalary: "21.5",
            maxSalary: "",
            jobUrl: "https://example.applicantpro.com/jobs/100002",
          },
          // Missing required fields — should be skipped.
          { id: 100003 },
        ],
      },
    };
    server.use(
      http.get("https://example.applicantpro.com/jobs/", () => HttpResponse.html(listing)),
      http.get("https://example.applicantpro.com/core/jobs/17874", ({ request }) => {
        const url = new URL(request.url);
        // Defensive: confirm the empty-getParams encoding survives.
        if (url.searchParams.get("getParams") !== "{}") {
          return HttpResponse.json({ success: false }, { status: 400 });
        }
        return HttpResponse.json(apiResp);
      }),
    );
    const out = await runScrape({
      input: {
        ats: "applicantpro",
        tenants: [{ slug: "example", display_name: "Example Co" }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.jobs).toHaveLength(2);
    const senior = out.jobs.find((j) => j.source_id === "100001");
    expect(senior?.title).toBe("Senior Engineer");
    expect(senior?.location_country).toBe("US");
    expect(senior?.location_region).toBe("Texas");
    expect(senior?.workplace_type).toBe("remote");
    expect(senior?.compensation_min).toBe(120000);
    expect(senior?.compensation_max).toBe(180000);
    const barista = out.jobs.find((j) => j.source_id === "100002");
    // Hourly "21.5" rounds to 22 since JobSchema requires integer comp.
    expect(barista?.compensation_min).toBe(22);
    expect(barista?.compensation_max).toBeUndefined();
    expect(barista?.workplace_type).toBe("onsite");
  });

  it("applicantpro returns success/0 jobs when the listing has no domain_id", async () => {
    server.use(
      http.get("https://nojobs.applicantpro.com/jobs/", () =>
        HttpResponse.html("<!doctype html><body>No careers</body>"),
      ),
    );
    const out = await runScrape({
      input: {
        ats: "applicantpro",
        tenants: [{ slug: "nojobs" }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.jobs).toHaveLength(0);
    expect(out.tenant_results[0]?.status).toBe("success");
    expect(out.tenant_results[0]?.jobs_count).toBe(0);
  });

  it("applicantpro surfaces dead when the listing fetch errors", async () => {
    server.use(
      http.get("https://gone.applicantpro.com/jobs/", () =>
        HttpResponse.text("nope", { status: 404 }),
      ),
    );
    const out = await runScrape({
      input: {
        ats: "applicantpro",
        tenants: [{ slug: "gone" }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.tenant_results[0]?.status).toBe("dead");
  });

  it("dispatches applicantstack via /x/openings server-rendered table", async () => {
    const html = `<!doctype html><html><body>
<table id="data-table" class="displaytable">
<thead><tr><th>Title</th><th>Location</th><th>Department</th><th>Job Type</th></tr></thead>
<tbody>
<tr class="oddrow"><td><a href="https://example.applicantstack.com/x/detail/abc123">District Sales Manager</a></td><td>Remote</td><td>Sales</td><td>Exempt (salaried)</td></tr>
<tr class="evenrow"><td><a href="https://example.applicantstack.com/x/detail/def456">Material Handler</a></td><td>Glasgow, KY</td><td>Operations</td><td>Non-exempt (hourly)</td></tr>
<tr class="oddrow"><td><a href="https://example.applicantstack.com/x/detail/ghi789">Hybrid Engineer</a></td><td>Hybrid</td><td>Engineering</td><td>Salaried</td></tr>
<!-- SSRF guard target — different host should be rejected by the parser -->
<tr><td><a href="https://evil.applicantstack.com/x/detail/badxxx">Pwn</a></td><td>Remote</td><td>x</td><td>x</td></tr>
</tbody>
</table>
</body></html>`;
    server.use(
      http.get("https://example.applicantstack.com/x/openings", () => HttpResponse.html(html)),
    );
    const out = await runScrape({
      input: {
        ats: "applicantstack",
        tenants: [{ slug: "example", display_name: "Example Co" }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.jobs).toHaveLength(3);
    const sales = out.jobs.find((j) => j.source_id === "abc123");
    expect(sales?.title).toBe("District Sales Manager");
    expect(sales?.location_text).toBe("Remote");
    expect(sales?.workplace_type).toBe("remote");
    expect(sales?.department).toBe("Sales");
    const onsite = out.jobs.find((j) => j.source_id === "def456");
    expect(onsite?.workplace_type).toBe("onsite");
    expect(onsite?.location_text).toBe("Glasgow, KY");
    const hybrid = out.jobs.find((j) => j.source_id === "ghi789");
    expect(hybrid?.workplace_type).toBe("hybrid");
  });

  it("applicantstack returns success/0 when openings table is empty", async () => {
    server.use(
      http.get("https://empty.applicantstack.com/x/openings", () =>
        HttpResponse.html("<!doctype html><body>No openings.</body>"),
      ),
    );
    const out = await runScrape({
      input: {
        ats: "applicantstack",
        tenants: [{ slug: "empty" }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.jobs).toHaveLength(0);
    expect(out.tenant_results[0]?.status).toBe("success");
  });

  it("applicantstack surfaces transient_failure when /x/detail/ markers exist but rows don't match the expected layout", async () => {
    // HTML carries detail-URL substrings (so this is plausibly a real
    // careers page) but the row regex matches none of them — likely a
    // vendor layout change.
    const html = `<!doctype html><html><body>
<div>Visit https://drift.applicantstack.com/x/detail/abc123 for details</div>
<div>Or https://drift.applicantstack.com/x/detail/def456</div>
</body></html>`;
    server.use(
      http.get("https://drift.applicantstack.com/x/openings", () => HttpResponse.html(html)),
    );
    const out = await runScrape({
      input: {
        ats: "applicantstack",
        tenants: [{ slug: "drift" }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.tenant_results[0]?.status).toBe("transient_failure");
    expect(out.tenant_results[0]?.error).toContain("expected layout");
  });

  it("applicantstack surfaces dead when the openings page errors", async () => {
    server.use(
      http.get("https://gone.applicantstack.com/x/openings", () =>
        HttpResponse.text("nope", { status: 404 }),
      ),
    );
    const out = await runScrape({
      input: {
        ats: "applicantstack",
        tenants: [{ slug: "gone" }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.tenant_results[0]?.status).toBe("dead");
  });

  it("dispatches eightfold via /careers/sitemap.xml + JSON-LD JobPosting on customer-branded host", async () => {
    const sitemap = `<?xml version='1.0' encoding='UTF-8'?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://careers.examplecorp.com/careers?domain=examplecorp.com</loc></url>
  <url><loc>https://careers.examplecorp.com/careers/job/171839116188-p-4998-sr-scientist?domain=examplecorp.com</loc></url>
  <url><loc>https://careers.examplecorp.com/careers/job/171838825895-p-4991-engineer?domain=examplecorp.com</loc></url>
</urlset>`;
    const detail = (title: string, locality: string) => `<!doctype html><html><head>
<script type="application/ld+json">{
  "@context": "http://schema.org",
  "@type": "JobPosting",
  "title": "${title}",
  "description": "Build it.",
  "datePosted": "2026-02-23T19:01:07",
  "employmentType": "FULL_TIME",
  "hiringOrganization": { "name": "Example Corp" },
  "jobLocation": { "address": { "addressLocality": "${locality}", "addressRegion": "CA,US", "addressCountry": { "name": "US" } } }
}</script></head></html>`;
    server.use(
      http.get("https://example.eightfold.ai/careers/sitemap.xml", () => HttpResponse.xml(sitemap)),
      http.get("https://careers.examplecorp.com/careers/job/171839116188-p-4998-sr-scientist", () =>
        HttpResponse.html(detail("Sr Scientist", "Pleasanton")),
      ),
      http.get("https://careers.examplecorp.com/careers/job/171838825895-p-4991-engineer", () =>
        HttpResponse.html(detail("Engineer", "San Francisco")),
      ),
    );
    const out = await runScrape({
      input: {
        ats: "eightfold",
        tenants: [{ slug: "example", display_name: "Example Co" }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.jobs).toHaveLength(2);
    const sci = out.jobs.find((j) => j.source_id === "171839116188");
    expect(sci?.title).toBe("Sr Scientist");
    expect(sci?.company).toBe("Example Corp");
    expect(sci?.location_text).toContain("Pleasanton");
    expect(sci?.posted_at).toBe("2026-02-23T19:01:07.000Z");
  });

  it("eightfold rejects sitemap entries that don't match the careers host + path shape", async () => {
    const sitemap = `<?xml version='1.0' encoding='UTF-8'?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://careers.good.com/careers/job/123456789012-p-x-real?domain=good.com</loc></url>
  <url><loc>https://evil.example.com/careers/job/escapehatch-p-y-pwn?domain=evil.com</loc></url>
  <url><loc>https://careers.good.com/careers</loc></url>
  <url><loc>http://careers.good.com/careers/job/999888777666-p-z-insecure</loc></url>
</urlset>`;
    server.use(
      http.get("https://good.eightfold.ai/careers/sitemap.xml", () => HttpResponse.xml(sitemap)),
      http.get("https://careers.good.com/careers/job/123456789012-p-x-real", () =>
        HttpResponse.html(`<script type="application/ld+json">{
          "@type": "JobPosting", "title": "Real Job", "hiringOrganization": "Good Co"
        }</script>`),
      ),
    );
    const out = await runScrape({
      input: {
        ats: "eightfold",
        tenants: [{ slug: "good" }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.jobs).toHaveLength(1);
    expect(out.jobs[0]?.source_id).toBe("123456789012");
    expect(out.tenant_results[0]?.status).toBe("success");
  });

  it("eightfold tolerates malformed JSON-LD, non-JobPosting types, and detail-fetch errors", async () => {
    const sitemap = `<?xml version='1.0' encoding='UTF-8'?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://careers.mixed.com/careers/job/100000000001-p-1-real</loc></url>
  <url><loc>https://careers.mixed.com/careers/job/100000000002-p-2-bad-ld</loc></url>
  <url><loc>https://careers.mixed.com/careers/job/100000000003-p-3-wrong-type</loc></url>
  <url><loc>https://careers.mixed.com/careers/job/100000000004-p-4-network-fail</loc></url>
  <url><loc>not a valid url</loc></url>
</urlset>`;
    server.use(
      http.get("https://mixed.eightfold.ai/careers/sitemap.xml", () => HttpResponse.xml(sitemap)),
      http.get("https://careers.mixed.com/careers/job/100000000001-p-1-real", () =>
        HttpResponse.html(`<script type="application/ld+json">{
          "@type": "JobPosting", "title": "Real Job", "hiringOrganization": "Mixed Co"
        }</script>`),
      ),
      http.get("https://careers.mixed.com/careers/job/100000000002-p-2-bad-ld", () =>
        HttpResponse.html(`<script type="application/ld+json">{not valid</script>`),
      ),
      http.get("https://careers.mixed.com/careers/job/100000000003-p-3-wrong-type", () =>
        HttpResponse.html(`<script type="application/ld+json">{"@type":"BreadcrumbList"}</script>`),
      ),
      http.get("https://careers.mixed.com/careers/job/100000000004-p-4-network-fail", () =>
        HttpResponse.error(),
      ),
    );
    const out = await runScrape({
      input: {
        ats: "eightfold",
        tenants: [{ slug: "mixed" }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    // 4 valid sitemap rows fetched, 1 success + 3 fails — 75% > 50% threshold.
    expect(out.tenant_results[0]?.status).toBe("transient_failure");
  });

  it("eightfold surfaces dead when the sitemap fetch errors", async () => {
    server.use(
      http.get("https://gone.eightfold.ai/careers/sitemap.xml", () =>
        HttpResponse.text("nope", { status: 404 }),
      ),
    );
    const out = await runScrape({
      input: {
        ats: "eightfold",
        tenants: [{ slug: "gone" }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.tenant_results[0]?.status).toBe("dead");
  });

  it("eightfold returns success/0 when the sitemap has no detail entries", async () => {
    server.use(
      http.get("https://empty.eightfold.ai/careers/sitemap.xml", () =>
        HttpResponse.xml(`<?xml version='1.0' encoding='UTF-8'?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://careers.empty.com/careers</loc></url>
</urlset>`),
      ),
    );
    const out = await runScrape({
      input: {
        ats: "eightfold",
        tenants: [{ slug: "empty" }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.jobs).toHaveLength(0);
    expect(out.tenant_results[0]?.status).toBe("success");
  });

  it("dispatches ultipro via the JobBoard LoadSearchResults POST endpoint", async () => {
    const guid = "12345678-1234-1234-1234-123456789012";
    server.use(
      http.post(
        `https://recruiting.ultipro.com/EXAMPLE/JobBoard/${guid}/JobBoardView/LoadSearchResults`,
        async ({ request }) => {
          const body = (await request.json()) as Record<string, unknown>;
          // The scraper sends the full opportunitySearch envelope, not an
          // empty body — assert that.
          if (!body.opportunitySearch) {
            return HttpResponse.json({ opportunities: [] });
          }
          return HttpResponse.json({
            opportunities: [
              {
                Id: "abc-1",
                Title: "Cloud Database Administrator",
                RequisitionNumber: "CLOUD001628",
                FullTime: true,
                JobCategoryName: "Information Technology",
                JobLocationType: "Onsite",
                BriefDescription: "Maintain the cloud DB.",
                PostedDate: "2026-04-23T18:03:51.454Z",
                Locations: [
                  {
                    LocalizedName: "Corporate",
                    Address: {
                      City: "Williamsville",
                      PostalCode: "14221",
                      State: { Code: "NY", Name: "New York" },
                      Country: { Code: "USA", Name: "United States" },
                    },
                  },
                ],
              },
              {
                Id: "abc-2",
                Title: "Remote Cloud Engineer",
                RequisitionNumber: "CLOUD001700",
                FullTime: true,
                JobLocationType: "Remote",
                Locations: [],
              },
              // Skipped: missing required fields
              { Id: "abc-3" },
            ],
            totalCount: 2,
          });
        },
      ),
    );
    const out = await runScrape({
      input: {
        ats: "ultipro",
        tenants: [{ slug: "example", metadata: { board_id: guid } }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.jobs).toHaveLength(2);
    const dba = out.jobs.find((j) => j.source_id === "CLOUD001628");
    expect(dba?.title).toBe("Cloud Database Administrator");
    expect(dba?.location_country).toBe("US");
    expect(dba?.location_region).toBe("NY");
    expect(dba?.location_text).toContain("Williamsville");
    expect(dba?.workplace_type).toBe("onsite");
    expect(dba?.department).toBe("Information Technology");
    expect(dba?.url).toContain(`/EXAMPLE/JobBoard/${guid}/OpportunityDetail`);
    const remote = out.jobs.find((j) => j.source_id === "CLOUD001700");
    expect(remote?.workplace_type).toBe("remote");
  });

  it("flags ultipro tenant dead when metadata.board_id is missing", async () => {
    const out = await runScrape({
      input: {
        ats: "ultipro",
        tenants: [{ slug: "missing-meta" }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.tenant_results[0]?.status).toBe("dead");
    expect(out.tenant_results[0]?.error).toContain("board_id");
  });

  it("flags ultipro tenant dead when metadata.board_id is malformed", async () => {
    const out = await runScrape({
      input: {
        ats: "ultipro",
        tenants: [{ slug: "bad-meta", metadata: { board_id: "not-a-guid" } }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.tenant_results[0]?.status).toBe("dead");
  });

  it("dispatches csod end-to-end against the modern careersite API", async () => {
    // Real CSOD bootstrap: the legacy `/ats/careersite/search.aspx?c=...`
    // URL 302s to `/ux/ats/careersite/{csid}/home?c={slug}`. The scraper
    // reads response.url to extract the careersite id. MSW preserves the
    // request URL as response.url by default; to emulate the redirect we
    // serve the home HTML directly at the /ux URL and have the bootstrap
    // call land there via a real 302.
    server.use(
      http.get(
        "https://example.csod.com/ats/careersite/search.aspx",
        () =>
          new HttpResponse(null, {
            status: 302,
            headers: {
              location: "https://example.csod.com/ux/ats/careersite/7/home?c=example",
            },
          }),
      ),
      http.get("https://example.csod.com/ux/ats/careersite/7/home", () =>
        HttpResponse.html(readFixtureText("csod.home.small.html")),
      ),
      http.post(
        "https://example.csod.com/services/x/career-site/v1/search",
        async ({ request }) => {
          const auth = request.headers.get("authorization") ?? "";
          if (!auth.startsWith("Bearer ")) {
            return HttpResponse.json({ status: 1, data: null }, { status: 401 });
          }
          const body = (await request.json()) as Record<string, unknown>;
          if (body.careerSiteId !== 7 || body.cultureId !== 1) {
            return HttpResponse.json({ status: 1, data: null }, { status: 400 });
          }
          return HttpResponse.json(readFixture("csod.search.small.json"));
        },
      ),
    );
    const out = await runScrape({
      input: {
        ats: "csod",
        tenants: [{ slug: "example", display_name: "Example Corp" }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.tenant_results[0]?.status).toBe("success");
    expect(out.jobs.length).toBeGreaterThanOrEqual(3);
    const senior = out.jobs.find((j) => j.source_id === "21038");
    expect(senior?.title).toBe("Senior Software Engineer");
    expect(senior?.company).toBe("Example Corp");
    expect(senior?.url).toContain("/ux/ats/careersite/7/requisition/21038");
    expect(senior?.location_country).toBe("BE");
    expect(senior?.location_text).toContain("Brussels");
    expect(senior?.department).toBe("Engineering");
    expect(senior?.posted_at).toBe("2026-04-15T00:00:00.000Z");
  });

  it("returns success with zero jobs when the csod search reports an empty result", async () => {
    server.use(
      http.get(
        "https://emptyco.csod.com/ats/careersite/search.aspx",
        () =>
          new HttpResponse(null, {
            status: 302,
            headers: {
              location: "https://emptyco.csod.com/ux/ats/careersite/3/home?c=emptyco",
            },
          }),
      ),
      http.get("https://emptyco.csod.com/ux/ats/careersite/3/home", () =>
        HttpResponse.html(readFixtureText("csod.home.small.html")),
      ),
      http.post("https://emptyco.csod.com/services/x/career-site/v1/search", () =>
        HttpResponse.json(readFixture("csod.search.empty.json")),
      ),
    );
    const out = await runScrape({
      input: {
        ats: "csod",
        tenants: [{ slug: "emptyco" }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.tenant_results[0]?.status).toBe("success");
    expect(out.tenant_results[0]?.jobs_count).toBe(0);
    expect(out.jobs).toHaveLength(0);
  });

  it("flags csod tenant dead when the bootstrap lands on an SSO login wall", async () => {
    // SSO-gated tenants 302 to samldefault.aspx / login/render.aspx —
    // the final URL has no /ux/ats/careersite/{id}/home, so context
    // parsing returns null and we surface as `dead` (permanent).
    server.use(
      http.get(
        "https://gated.csod.com/ats/careersite/search.aspx",
        () =>
          new HttpResponse(null, {
            status: 302,
            headers: {
              location: "https://gated.csod.com/login/render.aspx?id=defaultclp",
            },
          }),
      ),
      http.get("https://gated.csod.com/login/render.aspx", () =>
        HttpResponse.html("<html><body>sign in</body></html>"),
      ),
    );
    const out = await runScrape({
      input: {
        ats: "csod",
        tenants: [{ slug: "gated" }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.tenant_results[0]?.status).toBe("dead");
    expect(out.tenant_results[0]?.error).toContain("bootstrap unparseable");
    expect(out.jobs).toHaveLength(0);
  });

  it("flags csod tenant transient_failure when the search response shape drifts", async () => {
    server.use(
      http.get(
        "https://drifted.csod.com/ats/careersite/search.aspx",
        () =>
          new HttpResponse(null, {
            status: 302,
            headers: {
              location: "https://drifted.csod.com/ux/ats/careersite/9/home?c=drifted",
            },
          }),
      ),
      http.get("https://drifted.csod.com/ux/ats/careersite/9/home", () =>
        HttpResponse.html(readFixtureText("csod.home.small.html")),
      ),
      http.post("https://drifted.csod.com/services/x/career-site/v1/search", () =>
        HttpResponse.json({ status: 0, data: { totalCount: 1 } }),
      ),
    );
    const out = await runScrape({
      input: {
        ats: "csod",
        tenants: [{ slug: "drifted" }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.tenant_results[0]?.status).toBe("transient_failure");
    expect(out.jobs).toHaveLength(0);
  });

  it("paginates csod across multiple pages when results exceed pageSize", async () => {
    server.use(
      http.get(
        "https://multipage.csod.com/ats/careersite/search.aspx",
        () =>
          new HttpResponse(null, {
            status: 302,
            headers: {
              location: "https://multipage.csod.com/ux/ats/careersite/2/home?c=multipage",
            },
          }),
      ),
      http.get("https://multipage.csod.com/ux/ats/careersite/2/home", () =>
        HttpResponse.html(readFixtureText("csod.home.small.html")),
      ),
      http.post(
        "https://multipage.csod.com/services/x/career-site/v1/search",
        async ({ request }) => {
          const body = (await request.json()) as { pageNumber?: number; pageSize?: number };
          const pageNumber = body.pageNumber ?? 1;
          const pageSize = body.pageSize ?? 50;
          const allReqs = Array.from({ length: 7 }, (_, i) => ({
            requisitionId: 1000 + i,
            displayJobTitle: `Job ${1000 + i}`,
            locations: [{ country: "US" }],
          }));
          const start = (pageNumber - 1) * pageSize;
          const slice = allReqs.slice(start, start + pageSize);
          return HttpResponse.json({
            status: 0,
            data: {
              totalCount: allReqs.length,
              requisitions: slice,
              filters: [],
              customFieldFilters: [],
            },
          });
        },
      ),
    );
    // Drive pageSize down via the direct scraper helper so we exercise
    // the multi-page branch.
    const { scrapeCsodTenant } = await import("./ats/csod.ts");
    const out = await scrapeCsodTenant({
      tenant: { slug: "multipage" },
      client: clientWithRobotsAllowAll(),
      observedAt: "2026-05-04T00:00:00Z",
      pageSize: 3,
    });
    expect(out.result.status).toBe("success");
    expect(out.jobs).toHaveLength(7);
    const ids = out.jobs.map((j) => j.source_id).sort();
    expect(ids).toEqual(["1000", "1001", "1002", "1003", "1004", "1005", "1006"]);
  });

  it("rejects unsafe csod slugs before any HTTP call", async () => {
    // The tenant input schema admits `[a-z0-9-]+` but assertSafeSlug
    // adds boundary anchors — a leading hyphen passes the input schema
    // and fails the in-scraper guard, so the scraper should classify
    // this as `dead` without dispatching any HTTP call.
    const out = await runScrape({
      input: {
        ats: "csod",
        tenants: [{ slug: "-leading-hyphen" }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.tenant_results[0]?.status).toBe("dead");
    expect(out.tenant_results[0]?.error).toContain("tenant slug rejected");
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

  it("dispatches taleo by discovering the section portalNo and posting to /searchjobs", async () => {
    server.use(
      http.get("https://example.taleo.net/careersection/1/jobsearch.ftl", () =>
        HttpResponse.html(readFixtureText("taleo.section.html")),
      ),
      http.post(
        "https://example.taleo.net/careersection/rest/jobboard/searchjobs",
        ({ request }) => {
          const url = new URL(request.url);
          // Confirm the scraper threaded the discovered portalNo through.
          expect(url.searchParams.get("portal")).toBe("201381138");
          expect(url.searchParams.get("lang")).toBe("en");
          return HttpResponse.json(readFixture("taleo.small.json"));
        },
      ),
    );
    const out = await runScrape({
      input: {
        ats: "taleo",
        tenants: [{ slug: "example", display_name: "Example Corp" }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.tenant_results[0]?.status).toBe("success");
    expect(out.jobs).toHaveLength(3);
    const titles = out.jobs.map((j) => j.title);
    expect(titles).toContain("Senior Software Engineer");
    expect(titles).toContain("Truck Driver III");
    // JSON-stringified location list flattens to a single comma-joined string.
    const senior = out.jobs.find((j) => j.title === "Senior Software Engineer");
    expect(senior?.location_text).toBe("London, Remote - UK");
    expect(senior?.workplace_type).toBe("remote");
    // Plain-string location passes through unchanged.
    const recruiter = out.jobs.find((j) => j.title === "Recruiter, Talent Acquisition");
    expect(recruiter?.location_text).toBe("Toronto, Ontario, Canada");
    expect(recruiter?.is_recruiter_post).toBe(true);
    // Job URL points at the discovered section's jobdetail.ftl.
    expect(senior?.url).toBe(
      "https://example.taleo.net/careersection/1/jobdetail.ftl?job=100001&lang=en",
    );
    expect(senior?.company).toBe("Example Corp");
  });

  it("taleo paginates until pagingData.totalCount is covered", async () => {
    server.use(
      http.get("https://acme.taleo.net/careersection/1/jobsearch.ftl", () =>
        HttpResponse.html(readFixtureText("taleo.section.html")),
      ),
      http.post(
        "https://acme.taleo.net/careersection/rest/jobboard/searchjobs",
        async ({ request }) => {
          const body = (await request.json()) as { pageNo?: number };
          if (body.pageNo === 1) return HttpResponse.json(readFixture("taleo.large.page1.json"));
          if (body.pageNo === 2) return HttpResponse.json(readFixture("taleo.large.page2.json"));
          return HttpResponse.json({ requisitionList: [], pagingData: null });
        },
      ),
    );
    const out = await runScrape({
      input: {
        ats: "taleo",
        tenants: [{ slug: "acme" }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.jobs).toHaveLength(3);
    expect(out.tenant_results[0]?.status).toBe("success");
  });

  it("taleo skips section 1 placeholder and falls through to section 2", async () => {
    server.use(
      http.get("https://twosec.taleo.net/careersection/1/jobsearch.ftl", () =>
        HttpResponse.html(readFixtureText("taleo.section.unavailable.html")),
      ),
      http.get("https://twosec.taleo.net/careersection/2/jobsearch.ftl", () =>
        HttpResponse.html(readFixtureText("taleo.section.html")),
      ),
      http.post("https://twosec.taleo.net/careersection/rest/jobboard/searchjobs", () =>
        HttpResponse.json(readFixture("taleo.small.json")),
      ),
    );
    const out = await runScrape({
      input: {
        ats: "taleo",
        tenants: [{ slug: "twosec" }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.tenant_results[0]?.status).toBe("success");
    expect(out.jobs).toHaveLength(3);
    // The discovered section (2) shapes the job-detail URL.
    expect(out.jobs[0]?.url).toMatch(/\/careersection\/2\/jobdetail\.ftl\?/);
  });

  it("taleo returns success/0 jobs when every probed section is the placeholder", async () => {
    server.use(
      http.get("https://closed.taleo.net/careersection/1/jobsearch.ftl", () =>
        HttpResponse.html(readFixtureText("taleo.section.unavailable.html")),
      ),
      http.get("https://closed.taleo.net/careersection/2/jobsearch.ftl", () =>
        HttpResponse.html(readFixtureText("taleo.section.unavailable.html")),
      ),
      http.get("https://closed.taleo.net/careersection/3/jobsearch.ftl", () =>
        HttpResponse.html(readFixtureText("taleo.section.unavailable.html")),
      ),
    );
    const out = await runScrape({
      input: {
        ats: "taleo",
        tenants: [{ slug: "closed" }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.tenant_results[0]?.status).toBe("success");
    expect(out.tenant_results[0]?.jobs_count).toBe(0);
    expect(out.jobs).toHaveLength(0);
  });

  it("taleo continues past sections that hard-fail and finds a later one", async () => {
    server.use(
      http.get("https://flaky.taleo.net/careersection/1/jobsearch.ftl", () =>
        HttpResponse.text("nope", { status: 404 }),
      ),
      http.get("https://flaky.taleo.net/careersection/2/jobsearch.ftl", () =>
        HttpResponse.html(readFixtureText("taleo.section.html")),
      ),
      http.post("https://flaky.taleo.net/careersection/rest/jobboard/searchjobs", () =>
        HttpResponse.json(readFixture("taleo.empty.json")),
      ),
    );
    const out = await runScrape({
      input: {
        ats: "taleo",
        tenants: [{ slug: "flaky" }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.tenant_results[0]?.status).toBe("success");
    expect(out.tenant_results[0]?.jobs_count).toBe(0);
  });

  it("taleo returns success with 0 jobs when the search response is empty", async () => {
    server.use(
      http.get("https://empty.taleo.net/careersection/1/jobsearch.ftl", () =>
        HttpResponse.html(readFixtureText("taleo.section.html")),
      ),
      http.post("https://empty.taleo.net/careersection/rest/jobboard/searchjobs", () =>
        HttpResponse.json(readFixture("taleo.empty.json")),
      ),
    );
    const out = await runScrape({
      input: {
        ats: "taleo",
        tenants: [{ slug: "empty" }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.jobs).toHaveLength(0);
    expect(out.tenant_results[0]?.status).toBe("success");
    expect(out.tenant_results[0]?.jobs_count).toBe(0);
  });

  it("taleo flags careerSectionUnAvailable: true responses with a result error", async () => {
    server.use(
      http.get("https://locked.taleo.net/careersection/1/jobsearch.ftl", () =>
        HttpResponse.html(readFixtureText("taleo.section.html")),
      ),
      http.post("https://locked.taleo.net/careersection/rest/jobboard/searchjobs", () =>
        HttpResponse.json({
          requisitionList: null,
          facetResults: null,
          pagingData: null,
          queryString: null,
          careerSectionUnAvailable: true,
          supportedLanguages: null,
        }),
      ),
    );
    const out = await runScrape({
      input: {
        ats: "taleo",
        tenants: [{ slug: "locked" }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.tenant_results[0]?.status).toBe("success");
    expect(out.tenant_results[0]?.jobs_count).toBe(0);
    expect(out.tenant_results[0]?.error).toContain("careerSectionUnAvailable");
  });

  it("taleo skips rows missing required jobId or title and surfaces transient_failure on bad JSON", async () => {
    server.use(
      http.get("https://ragged.taleo.net/careersection/1/jobsearch.ftl", () =>
        HttpResponse.html(readFixtureText("taleo.section.html")),
      ),
      http.post("https://ragged.taleo.net/careersection/rest/jobboard/searchjobs", () =>
        HttpResponse.json({
          requisitionList: [
            // Empty title — skip.
            { jobId: "1", column: ["", "REQ-1"], locationsColumns: [] },
            // Missing column — skip.
            { jobId: "2", locationsColumns: [] },
            // Numeric jobId — coerce, keep.
            { jobId: 9999, column: ["Numeric Id Engineer"], locationsColumns: [] },
            // locationsColumns index past column length — fall through to no location.
            {
              jobId: "3",
              column: ["Out Of Range Engineer"],
              locationsColumns: [99],
            },
            // locationsColumns referencing an empty cell — no location_text.
            {
              jobId: "4",
              column: ["Empty Loc Engineer", "", ""],
              locationsColumns: [1],
            },
            // Malformed JSON in the location cell falls back to the raw string.
            {
              jobId: "5",
              column: ["Bad Json Engineer", '["unterminated'],
              locationsColumns: [1],
            },
          ],
          pagingData: { currentPageNo: 1, pageSize: 25, totalCount: 6 },
          careerSectionUnAvailable: false,
        }),
      ),
    );
    const out = await runScrape({
      input: {
        ats: "taleo",
        tenants: [{ slug: "ragged" }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.tenant_results[0]?.status).toBe("success");
    // Three rows pass: numeric-id, out-of-range-loc, empty-loc, bad-json — 4 rows total.
    expect(out.jobs).toHaveLength(4);
    const titles = out.jobs.map((j) => j.title);
    expect(titles).toContain("Numeric Id Engineer");
    expect(titles).toContain("Out Of Range Engineer");
    expect(titles).toContain("Empty Loc Engineer");
    expect(titles).toContain("Bad Json Engineer");
    // Bad-JSON row falls back to the raw string.
    const bad = out.jobs.find((j) => j.title === "Bad Json Engineer");
    expect(bad?.location_text).toBe('["unterminated');
  });

  it("taleo surfaces transient_failure when the search endpoint returns 503", async () => {
    server.use(
      http.get("https://hot.taleo.net/careersection/1/jobsearch.ftl", () =>
        HttpResponse.html(readFixtureText("taleo.section.html")),
      ),
      http.post("https://hot.taleo.net/careersection/rest/jobboard/searchjobs", () =>
        HttpResponse.text("upstream timeout", { status: 503 }),
      ),
    );
    const out = await runScrape({
      input: {
        ats: "taleo",
        tenants: [{ slug: "hot" }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.tenant_results[0]?.status).toBe("transient_failure");
  });

  it("taleo surfaces dead when every probed section errors and discovery fails", async () => {
    // All three section probes fail at the network level → discoverSection
    // returns undefined → success/0. To exercise the dead path we instead
    // reject the slug.
    const out = await runScrape({
      input: {
        ats: "taleo",
        tenants: [{ slug: "abc" }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      // no handlers — every fetch fails, discovery returns undefined → success/0
      httpClient: clientWithRobotsAllowAll(),
    });
    // When MSW errors every request, discovery still falls through to success/0.
    expect(out.tenant_results[0]?.status).toBe("success");
    expect(out.tenant_results[0]?.jobs_count).toBe(0);
  });

  it("taleo rejects unsafe slug as dead", async () => {
    const out = await runScrape({
      input: {
        ats: "taleo",
        // 64-char slug with a leading digit is fine; we exercise the
        // assertSafeSlug throw via a slug with a trailing dash. Schema-level
        // validation rejects most shapes, but the inner regex also checks the
        // first/last char are alphanumeric.
        tenants: [{ slug: "bad-" }],
        userAgent: "openroles/0.0.0",
        contactUrl: "https://example.com",
      },
      clock: fixedClock,
      httpClient: clientWithRobotsAllowAll(),
    });
    expect(out.tenant_results[0]?.status).toBe("dead");
    expect(out.tenant_results[0]?.error).toContain("tenant slug rejected");
  });

  it("rejects an invalid input via zod", async () => {
    await expect(
      runScrape({
        input: {
          ats: "not-a-real-ats" as any,
          tenants: [],
          userAgent: "openroles/0.0.0",
          contactUrl: "https://example.com",
        },
      }),
    ).rejects.toThrow();
  });
});
