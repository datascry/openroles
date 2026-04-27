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
    expect(ok.jobs[0]?.updated_at).toBeDefined();
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

  it("flags the remaining stubbed ATSes as transient_failure (scrapers not yet implemented)", async () => {
    const stubbed = [
      "csod",
      "taleo",
      "ultipro",
      "jobvite",
      "zohorecruit",
      "applicantpro",
      "applicantstack",
      "homerun",
      "factorial",
      "eightfold",
    ] as const;
    for (const ats of stubbed) {
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
