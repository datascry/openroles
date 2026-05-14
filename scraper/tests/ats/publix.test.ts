import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import fc from "fast-check";
import { parsePublixJobs, scrapePublixTenant } from "../../src/ats/publix.ts";
import { clientWithRobotsAllowAll, HttpResponse, http, makeServer } from "../helpers.ts";

const OBSERVED_AT = "2026-04-26T00:00:00Z";
const HOST = "corporate.publix.com";

const server = makeServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const smallFixture = {
  total: 1,
  jobs: [
    {
      jobId: "PUB-1",
      title: "Cashier",
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
    { jobId: "PUB-2001", title: "Store Manager", location: "Brooklyn, NY", country_code: "US" },
    { jobId: "PUB-2002", title: "Talent Recruiter", location: "Monrovia, CA", country_code: "US" },
    { jobId: "PUB-2003", title: "Remote Pharmacist", location: "Remote, US", country_code: "US" },
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

describe("parsePublixJobs", () => {
  it("parses small fixture and honors API URL", () => {
    const jobs = parsePublixJobs({
      tenant: { slug: "publix" },
      company: "Publix",
      response: smallFixture,
      observedAt: OBSERVED_AT,
    });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.title).toBe("Cashier");
    expect(jobs[0]?.location_country).toBe("US");
    expect(jobs[0]?.url).toBe(`https://${HOST}/careers/job/TJ-1`);
  });
  it("classifies remote, flags recruiter", () => {
    const jobs = parsePublixJobs({
      tenant: { slug: "publix" },
      company: "Publix",
      response: largeFixture,
      observedAt: OBSERVED_AT,
    });
    expect(jobs).toHaveLength(3);
    expect(jobs.find((j) => j.title.includes("Recruiter"))?.is_recruiter_post).toBe(true);
    expect(jobs.find((j) => j.title.includes("Remote"))?.workplace_type).toBe("remote");
  });
  it("trims, drops, dedupes", () => {
    const jobs = parsePublixJobs({
      tenant: { slug: "publix" },
      company: "Publix",
      response: edgeFixture,
      observedAt: OBSERVED_AT,
    });
    expect(jobs).toHaveLength(2);
    expect(jobs.find((j) => j.source_id === "ED1")?.title).toBe("Trimmed");
    expect(jobs.find((j) => j.source_id === "ED1")?.posted_at).toBeUndefined();
  });
  it("synthesizes URL on off-host (SSRF guard)", () => {
    const jobs = parsePublixJobs({
      tenant: { slug: "publix" },
      company: "Publix",
      response: { jobs: [{ jobId: "X1", title: "Engineer", url: "https://evil.example.com/X1" }] },
      observedAt: OBSERVED_AT,
    });
    expect(jobs[0]?.url).toBe(`https://${HOST}/careers/job/X1`);
  });
  it("falls back to results[]", () => {
    const jobs = parsePublixJobs({
      tenant: { slug: "publix" },
      company: "Publix",
      response: { results: [{ id: "X1", title: "Engineer" }] },
      observedAt: OBSERVED_AT,
    });
    expect(jobs).toHaveLength(1);
  });
  it("returns [] on empty response", () => {
    expect(
      parsePublixJobs({
        tenant: { slug: "publix" },
        company: "Publix",
        response: { total: 0, jobs: [] },
        observedAt: OBSERVED_AT,
      }),
    ).toEqual([]);
  });
  it("is deterministic (property)", () => {
    fc.assert(
      fc.property(fc.constantFrom("publix"), (slug) => {
        const a = parsePublixJobs({
          tenant: { slug },
          company: "Publix",
          response: largeFixture,
          observedAt: OBSERVED_AT,
        });
        const b = parsePublixJobs({
          tenant: { slug },
          company: "Publix",
          response: largeFixture,
          observedAt: OBSERVED_AT,
        });
        return JSON.stringify(a) === JSON.stringify(b);
      }),
      { numRuns: 10 },
    );
  });
});

describe("scrapePublixTenant", () => {
  it("rejects non-canonical slug", async () => {
    let calls = 0;
    server.use(
      http.get(`https://${HOST}/api/careers/jobs`, () => {
        calls += 1;
        return HttpResponse.json({ total: 0, jobs: [] });
      }),
    );
    const out = await scrapePublixTenant({
      tenant: { slug: "not-publix" },
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
      http.get(`https://${HOST}/api/careers/jobs`, ({ request }) => {
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
    const out = await scrapePublixTenant({
      tenant: { slug: "publix", display_name: "Publix" },
      client: clientWithRobotsAllowAll(),
      observedAt: OBSERVED_AT,
    });
    expect(calls).toBe(2);
    expect(out.result.jobs_count).toBe(120);
  });
  it("stops on short page (final)", async () => {
    let calls = 0;
    server.use(
      http.get(`https://${HOST}/api/careers/jobs`, () => {
        calls += 1;
        return HttpResponse.json(smallFixture);
      }),
    );
    const out = await scrapePublixTenant({
      tenant: { slug: "publix" },
      client: clientWithRobotsAllowAll(),
      observedAt: OBSERVED_AT,
    });
    expect(calls).toBe(1);
    expect(out.result.jobs_count).toBe(1);
  });
  it("classifies 5xx as transient_failure", async () => {
    server.use(
      http.get(`https://${HOST}/api/careers/jobs`, () =>
        HttpResponse.text("oops", { status: 503 }),
      ),
    );
    const out = await scrapePublixTenant({
      tenant: { slug: "publix" },
      client: clientWithRobotsAllowAll(),
      observedAt: OBSERVED_AT,
    });
    expect(out.result.status).toBe("transient_failure");
  });
});
