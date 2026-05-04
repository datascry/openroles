import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from "bun:test";
import fc from "fast-check";
import { parseWorkdayJobs, scrapeWorkdayTenant } from "../../src/ats/workday.ts";
import { HttpClient } from "../../src/http.ts";
import { RobotsTxtCache } from "../../src/robots.ts";
import {
  clientWithRobotsAllowAll,
  HttpResponse,
  http,
  makeServer,
  readFixture,
} from "../helpers.ts";

const OBSERVED_AT = "2026-04-26T00:00:00Z";
const HOST = "example.wd5.myworkdayjobs.com";

const server = makeServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("parseWorkdayJobs (fixture replay)", () => {
  it("parses the large fixture (page 1)", () => {
    const jobs = parseWorkdayJobs({
      tenant: { slug: "example" },
      company: "Example",
      host: HOST,
      site: "External",
      response: readFixture("workday.large.page1.json"),
      observedAt: OBSERVED_AT,
    });
    expect(jobs).toHaveLength(2);
    // Public-facing URL must include the site segment between host and
    // externalPath (the cxs JSON returns externalPath relative to
    // /<site>, NOT host root). Without it the link 404s. See the
    // workdayJobUrl comment for the empirical confirmation.
    expect(jobs[0]?.url).toBe(`https://${HOST}/External/job/Senior_Software_Engineer-100`);
    const recruiter = jobs.find((j) => j.title === "Senior Recruiter");
    expect(recruiter?.is_recruiter_post).toBe(true);
  });

  it("parses the small fixture", () => {
    const jobs = parseWorkdayJobs({
      tenant: { slug: "tinyco" },
      company: "tinyco",
      host: "tinyco.wd5.myworkdayjobs.com",
      site: "External",
      response: readFixture("workday.small.json"),
      observedAt: OBSERVED_AT,
    });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.workplace_type).toBe("remote");
  });

  it("joins bulletFields into a description excerpt", () => {
    const jobs = parseWorkdayJobs({
      tenant: { slug: "bulletco" },
      company: "BulletCo",
      host: HOST,
      site: "External",
      response: {
        total: 1,
        jobPostings: [
          {
            title: "Engineer",
            externalPath: "/job/Engineer-1",
            jobReqId: "REQ-B1",
            bulletFields: ["3+ years experience", "Remote eligible", "Senior level"],
          },
        ],
      },
      observedAt: OBSERVED_AT,
    });
    expect(jobs).toHaveLength(1);
    const desc = jobs[0]?.description_excerpt ?? "";
    expect(desc).toContain("3+ years experience");
    expect(desc).toContain("Remote eligible");
  });

  it("omits description_excerpt when bulletFields is empty or missing", () => {
    const jobs = parseWorkdayJobs({
      tenant: { slug: "nodesc" },
      company: "NoDesc",
      host: HOST,
      site: "External",
      response: {
        total: 1,
        jobPostings: [
          { title: "Role", externalPath: "/job/role-1", jobReqId: "R-1", bulletFields: [] },
        ],
      },
      observedAt: OBSERVED_AT,
    });
    expect(jobs[0]?.description_excerpt).toBeUndefined();
  });

  it("parses the edge fixture: missing jobReqId, missing leading slash, dedupe by id", () => {
    const jobs = parseWorkdayJobs({
      tenant: { slug: "edge" },
      company: "Edge",
      host: HOST,
      site: "External",
      response: readFixture("workday.edge.json"),
      observedAt: OBSERVED_AT,
    });
    expect(jobs).toHaveLength(2);
    const noReq = jobs.find((j) => j.title === "No JobReqId");
    expect(noReq?.source_id).toBe("no-req-id-job");
    const noSlash = jobs.find((j) => j.title === "Path with no leading slash");
    expect(noSlash?.url).toBe(`https://${HOST}/External/job/no-leading-slash`);
  });

  it("uses the alt-site that succeeded in the URL (Careers, not the External default)", () => {
    // Alt-site retry exists because ~70% of harvested workday tenants
    // 404 against External and live under Careers / External_Career_Site.
    // The cxs API returns externalPath relative to whichever site
    // matched, so the public URL must use that same site.
    const jobs = parseWorkdayJobs({
      tenant: { slug: "altsite" },
      company: "AltSite",
      host: HOST,
      site: "Careers",
      response: {
        total: 1,
        jobPostings: [{ title: "Engineer", externalPath: "/job/Engineer-1", jobReqId: "R1" }],
      },
      observedAt: OBSERVED_AT,
    });
    expect(jobs[0]?.url).toBe(`https://${HOST}/Careers/job/Engineer-1`);
  });
});

describe("parseWorkdayJobs (property)", () => {
  it("is deterministic on identical input", () => {
    const fixture = readFixture("workday.large.page1.json");
    fc.assert(
      fc.property(fc.constantFrom("a", "b"), (slug) => {
        const a = parseWorkdayJobs({
          tenant: { slug },
          company: slug,
          host: HOST,
          site: "External",
          response: fixture,
          observedAt: OBSERVED_AT,
        });
        const b = parseWorkdayJobs({
          tenant: { slug },
          company: slug,
          host: HOST,
          site: "External",
          response: fixture,
          observedAt: OBSERVED_AT,
        });
        return JSON.stringify(a) === JSON.stringify(b);
      }),
      { numRuns: 20 },
    );
  });
});

describe("scrapeWorkdayTenant", () => {
  it("paginates until total reached", async () => {
    let calls = 0;
    server.use(
      http.post(`https://${HOST}/wday/cxs/example/External/jobs`, async ({ request }) => {
        calls += 1;
        const body = (await request.json()) as { offset: number; limit: number };
        const fixture = body.offset === 0 ? "workday.large.page1.json" : "workday.large.page2.json";
        return HttpResponse.json(readFixture(fixture));
      }),
    );
    const client = clientWithRobotsAllowAll();
    const out = await scrapeWorkdayTenant({
      tenant: { slug: "example", display_name: "Example" },
      client,
      observedAt: OBSERVED_AT,
      host: HOST,
      site: "External",
      pageSize: 2,
    });
    expect(calls).toBe(2);
    expect(out.result.status).toBe("success");
    expect(out.result.jobs_count).toBe(4);
  });

  it("retries on 5xx then succeeds", async () => {
    let attempts = 0;
    server.use(
      http.post(`https://${HOST}/wday/cxs/flake/External/jobs`, () => {
        attempts += 1;
        if (attempts < 2) return new HttpResponse("err", { status: 503 });
        return HttpResponse.json(readFixture("workday.small.json"));
      }),
    );
    const client = clientWithRobotsAllowAll();
    const out = await scrapeWorkdayTenant({
      tenant: { slug: "flake" },
      client,
      observedAt: OBSERVED_AT,
      host: HOST,
      site: "External",
      pageSize: 20,
    });
    expect(out.result.status).toBe("success");
  });

  it("blocks on robots.txt", async () => {
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
    const out = await scrapeWorkdayTenant({
      tenant: { slug: "blocked" },
      client,
      observedAt: OBSERVED_AT,
      host: HOST,
      site: "External",
    });
    expect(out.result.status).toBe("dead");
  });

  it("stops paginating when page is short (final page)", async () => {
    let calls = 0;
    server.use(
      http.post(`https://${HOST}/wday/cxs/short/External/jobs`, () => {
        calls += 1;
        return HttpResponse.json(readFixture("workday.small.json"));
      }),
    );
    const client = clientWithRobotsAllowAll();
    const out = await scrapeWorkdayTenant({
      tenant: { slug: "short" },
      client,
      observedAt: OBSERVED_AT,
      host: HOST,
      site: "External",
      pageSize: 20,
    });
    expect(calls).toBe(1);
    expect(out.result.jobs_count).toBe(1);
  });

  it("respects maxPages cap", async () => {
    let calls = 0;
    server.use(
      http.post(`https://${HOST}/wday/cxs/huge/External/jobs`, () => {
        calls += 1;
        return HttpResponse.json({
          total: 1000,
          jobPostings: Array.from({ length: 2 }, (_, i) => ({
            title: `Job ${calls}-${i}`,
            externalPath: `/job/page${calls}-job${i}`,
            jobReqId: `REQ-${calls}-${i}`,
          })),
        });
      }),
    );
    const client = clientWithRobotsAllowAll();
    const out = await scrapeWorkdayTenant({
      tenant: { slug: "huge" },
      client,
      observedAt: OBSERVED_AT,
      host: HOST,
      site: "External",
      pageSize: 2,
      maxPages: 3,
    });
    expect(calls).toBe(3);
    expect(out.result.status).toBe("success");
    expect(out.result.jobs_count).toBe(6);
  });
});
