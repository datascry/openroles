import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import fc from "fast-check";
import { parseFastRetailingJobs, scrapeFastRetailingTenant } from "../../src/ats/fastretailing.ts";
import { clientWithRobotsAllowAll, HttpResponse, http, makeServer } from "../helpers.ts";

const OBSERVED_AT = "2026-04-26T00:00:00Z";
const HOST = "www.fastretailing.com";

const server = makeServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const smallFixture = {
  total: 1,
  jobs: [
    {
      jobId: "FR-1",
      title: "Crew Member",
      description: "Stock shelves and serve customers.",
      location: "Los Angeles, CA",
      country_code: "US",
      department: "Retail",
      postedDate: "2026-04-10T00:00:00Z",
      url: `https://${HOST}/careers/job/TJ-1`,
    },
  ],
};

const largeFixture = {
  total: 3,
  jobs: [
    { jobId: "FR-2001", title: "Store Manager", location: "Brooklyn, NY", country_code: "US" },
    {
      jobId: "FR-2002",
      title: "Talent Acquisition Recruiter",
      location: "Monrovia, CA",
      country_code: "US",
    },
    { jobId: "FR-2003", title: "Remote Buyer (West)", location: "Remote, US", country_code: "US" },
  ],
};

const edgeFixture = {
  total: 4,
  jobs: [
    { jobId: "ED1", title: "  Trimmed  ", location: "London, UK", postedDate: "not-a-date" },
    { jobId: "ED2", title: "No location" },
    { title: "Missing id, dropped" },
    { jobId: "ED1", title: "Duplicate id" },
  ],
};

describe("parseFastRetailingJobs", () => {
  it("parses small fixture and honors API URL", () => {
    const jobs = parseFastRetailingJobs({
      tenant: { slug: "fastretailing" },
      company: "Fast Retailing",
      response: smallFixture,
      observedAt: OBSERVED_AT,
    });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.title).toBe("Crew Member");
    expect(jobs[0]?.location_country).toBe("US");
    expect(jobs[0]?.url).toBe(`https://${HOST}/careers/job/TJ-1`);
  });
  it("classifies remote, flags recruiter", () => {
    const jobs = parseFastRetailingJobs({
      tenant: { slug: "fastretailing" },
      company: "Fast Retailing",
      response: largeFixture,
      observedAt: OBSERVED_AT,
    });
    expect(jobs).toHaveLength(3);
    expect(jobs.find((j) => j.title.includes("Recruiter"))?.is_recruiter_post).toBe(true);
    expect(jobs.find((j) => j.title.includes("Remote"))?.workplace_type).toBe("remote");
  });
  it("trims, drops, dedupes", () => {
    const jobs = parseFastRetailingJobs({
      tenant: { slug: "fastretailing" },
      company: "Fast Retailing",
      response: edgeFixture,
      observedAt: OBSERVED_AT,
    });
    expect(jobs).toHaveLength(2);
    expect(jobs.find((j) => j.source_id === "ED1")?.title).toBe("Trimmed");
    expect(jobs.find((j) => j.source_id === "ED1")?.posted_at).toBeUndefined();
  });
  it("synthesizes URL on off-host (SSRF guard)", () => {
    const jobs = parseFastRetailingJobs({
      tenant: { slug: "fastretailing" },
      company: "Fast Retailing",
      response: { jobs: [{ jobId: "X1", title: "Engineer", url: "https://evil.example.com/X1" }] },
      observedAt: OBSERVED_AT,
    });
    expect(jobs[0]?.url).toBe(`https://${HOST}/careers/job/X1`);
  });
  it("falls back to results[]", () => {
    const jobs = parseFastRetailingJobs({
      tenant: { slug: "fastretailing" },
      company: "Fast Retailing",
      response: { results: [{ id: "X1", title: "Engineer" }] },
      observedAt: OBSERVED_AT,
    });
    expect(jobs).toHaveLength(1);
  });
  it("returns [] on empty response", () => {
    expect(
      parseFastRetailingJobs({
        tenant: { slug: "fastretailing" },
        company: "Fast Retailing",
        response: { total: 0, jobs: [] },
        observedAt: OBSERVED_AT,
      }),
    ).toEqual([]);
  });
  it("is deterministic (property)", () => {
    fc.assert(
      fc.property(fc.constantFrom("fastretailing"), (slug) => {
        const a = parseFastRetailingJobs({
          tenant: { slug },
          company: "Fast Retailing",
          response: largeFixture,
          observedAt: OBSERVED_AT,
        });
        const b = parseFastRetailingJobs({
          tenant: { slug },
          company: "Fast Retailing",
          response: largeFixture,
          observedAt: OBSERVED_AT,
        });
        return JSON.stringify(a) === JSON.stringify(b);
      }),
      { numRuns: 10 },
    );
  });
});

describe("scrapeFastRetailingTenant", () => {
  it("rejects non-canonical slug", async () => {
    let calls = 0;
    server.use(
      http.get(`https://${HOST}/employment/api/jobs`, () => {
        calls += 1;
        return HttpResponse.json({ total: 0, jobs: [] });
      }),
    );
    const out = await scrapeFastRetailingTenant({
      tenant: { slug: "not-fastretailing" },
      client: clientWithRobotsAllowAll(),
      observedAt: OBSERVED_AT,
    });
    expect(out.result.status).toBe("dead");
    expect(out.result.error).toContain("single-tenant");
    expect(calls).toBe(0);
  });
  it("paginates until total reached", async () => {
    let calls = 0;
    server.use(
      http.get(`https://${HOST}/employment/api/jobs`, ({ request }) => {
        calls += 1;
        const url = new URL(request.url);
        const page = Number.parseInt(url.searchParams.get("page") ?? "1", 10);
        if (page === 1)
          return HttpResponse.json({
            total: 120,
            jobs: Array.from({ length: 100 }, (_, i) => ({ jobId: `P1-${i}`, title: `Crew ${i}` })),
          });
        return HttpResponse.json({
          total: 120,
          jobs: Array.from({ length: 20 }, (_, i) => ({ jobId: `P2-${i}`, title: `Crew ${i}` })),
        });
      }),
    );
    const out = await scrapeFastRetailingTenant({
      tenant: { slug: "fastretailing", display_name: "Fast Retailing" },
      client: clientWithRobotsAllowAll(),
      observedAt: OBSERVED_AT,
    });
    expect(calls).toBe(2);
    expect(out.result.jobs_count).toBe(120);
  });
  it("stops on short page (final)", async () => {
    let calls = 0;
    server.use(
      http.get(`https://${HOST}/employment/api/jobs`, () => {
        calls += 1;
        return HttpResponse.json(smallFixture);
      }),
    );
    const out = await scrapeFastRetailingTenant({
      tenant: { slug: "fastretailing" },
      client: clientWithRobotsAllowAll(),
      observedAt: OBSERVED_AT,
    });
    expect(calls).toBe(1);
    expect(out.result.jobs_count).toBe(1);
  });
  it("classifies 5xx as transient_failure", async () => {
    server.use(
      http.get(`https://${HOST}/employment/api/jobs`, () =>
        HttpResponse.text("oops", { status: 503 }),
      ),
    );
    const out = await scrapeFastRetailingTenant({
      tenant: { slug: "fastretailing" },
      client: clientWithRobotsAllowAll(),
      observedAt: OBSERVED_AT,
    });
    expect(out.result.status).toBe("transient_failure");
  });
});
