import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import fc from "fast-check";
import { parseWiproJobs, scrapeWiproTenant } from "../../src/ats/wipro.ts";
import { clientWithRobotsAllowAll, HttpResponse, http, makeServer } from "../helpers.ts";

const OBSERVED_AT = "2026-04-26T00:00:00Z";
const HOST = "careers.wipro.com";

const server = makeServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const smallFixture = {
  total: 1,
  results: [
    {
      jobId: "INFY-2026-12345",
      title: "Software Engineer",
      description: "Build distributed services.",
      location: "Bengaluru, India",
      country_code: "IN",
      department: "Application Development",
      datePosted: "2026-04-10T00:00:00Z",
      url: `https://${HOST}/careers-home/job/INFY-2026-12345`,
    },
  ],
};

const largeFixture = {
  total: 3,
  results: [
    {
      jobId: "I2001",
      title: "Senior Architect",
      description: "Lead architecture for digital transformation projects.",
      location: "Pune, India",
      country_code: "IN",
      department: "Architecture",
      datePosted: "2026-04-08T00:00:00Z",
    },
    {
      jobId: "I2002",
      title: "Technical Recruiter",
      description: "Hire engineers across India.",
      location: "Hyderabad, India",
      country_code: "IN",
      datePosted: "2026-04-09T00:00:00Z",
    },
    {
      jobId: "I2003",
      title: "Software Engineer (Remote)",
      description: "Remote-friendly senior role.",
      location: "Remote, India",
      country_code: "IN",
    },
  ],
};

const edgeFixture = {
  total: 4,
  results: [
    { jobId: "ED1", title: "  Trimmed  ", location: "London, UK", datePosted: "not-a-date" },
    { jobId: "ED2", title: "No location" },
    { title: "Missing id (dropped)" },
    { jobId: "ED1", title: "Duplicate id (deduped)" },
  ],
};

describe("parseWiproJobs", () => {
  it("parses the small fixture and honors API-provided URL", () => {
    const jobs = parseWiproJobs({
      tenant: { slug: "wipro" },
      company: "Wipro",
      response: smallFixture,
      observedAt: OBSERVED_AT,
    });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.title).toBe("Software Engineer");
    expect(jobs[0]?.location_text).toBe("Bengaluru, India");
    expect(jobs[0]?.location_country).toBe("IN");
    expect(jobs[0]?.department).toBe("Application Development");
    expect(jobs[0]?.url).toBe(`https://${HOST}/careers-home/job/INFY-2026-12345`);
  });

  it("classifies remote, flags recruiter titles", () => {
    const jobs = parseWiproJobs({
      tenant: { slug: "wipro" },
      company: "Wipro",
      response: largeFixture,
      observedAt: OBSERVED_AT,
    });
    expect(jobs).toHaveLength(3);
    expect(jobs.find((j) => j.title === "Technical Recruiter")?.is_recruiter_post).toBe(true);
    expect(jobs.find((j) => j.title.includes("Remote"))?.workplace_type).toBe("remote");
  });

  it("trims, drops missing-id rows, dedupes", () => {
    const jobs = parseWiproJobs({
      tenant: { slug: "wipro" },
      company: "Wipro",
      response: edgeFixture,
      observedAt: OBSERVED_AT,
    });
    expect(jobs).toHaveLength(2);
    const trimmed = jobs.find((j) => j.source_id === "ED1");
    expect(trimmed?.title).toBe("Trimmed");
    expect(trimmed?.posted_at).toBeUndefined();
  });

  it("synthesizes URL when API URL is off-domain (SSRF guard)", () => {
    const jobs = parseWiproJobs({
      tenant: { slug: "wipro" },
      company: "Wipro",
      response: {
        results: [{ jobId: "X1", title: "Engineer", url: "https://evil.example.com/X1" }],
      },
      observedAt: OBSERVED_AT,
    });
    expect(jobs[0]?.url).toBe(`https://${HOST}/careers-home/job/X1`);
  });

  it("falls back to jobs[] when response uses alternate shape", () => {
    const jobs = parseWiproJobs({
      tenant: { slug: "wipro" },
      company: "Wipro",
      response: { jobs: [{ id: "X1", title: "Engineer" }] },
      observedAt: OBSERVED_AT,
    });
    expect(jobs).toHaveLength(1);
  });

  it("returns [] on empty response", () => {
    expect(
      parseWiproJobs({
        tenant: { slug: "wipro" },
        company: "Wipro",
        response: { total: 0, results: [] },
        observedAt: OBSERVED_AT,
      }),
    ).toEqual([]);
  });

  it("is deterministic (property)", () => {
    fc.assert(
      fc.property(fc.constantFrom("wipro"), (slug) => {
        const a = parseWiproJobs({
          tenant: { slug },
          company: "Wipro",
          response: largeFixture,
          observedAt: OBSERVED_AT,
        });
        const b = parseWiproJobs({
          tenant: { slug },
          company: "Wipro",
          response: largeFixture,
          observedAt: OBSERVED_AT,
        });
        return JSON.stringify(a) === JSON.stringify(b);
      }),
      { numRuns: 10 },
    );
  });
});

describe("scrapeWiproTenant", () => {
  it("rejects non-canonical slug without making a request", async () => {
    let calls = 0;
    server.use(
      http.get(`https://${HOST}/careers-home/api/jobs`, () => {
        calls += 1;
        return HttpResponse.json({ total: 0, results: [] });
      }),
    );
    const out = await scrapeWiproTenant({
      tenant: { slug: "not-wipro" },
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
      http.get(`https://${HOST}/careers-home/api/jobs`, ({ request }) => {
        calls += 1;
        const url = new URL(request.url);
        const page = Number.parseInt(url.searchParams.get("page") ?? "1", 10);
        if (page === 1) {
          return HttpResponse.json({
            total: 60,
            results: Array.from({ length: 50 }, (_, i) => ({
              jobId: `P1-${i}`,
              title: `Engineer ${i}`,
            })),
          });
        }
        return HttpResponse.json({
          total: 60,
          results: Array.from({ length: 10 }, (_, i) => ({
            jobId: `P2-${i}`,
            title: `Engineer ${i}`,
          })),
        });
      }),
    );
    const out = await scrapeWiproTenant({
      tenant: { slug: "wipro", display_name: "Wipro" },
      client: clientWithRobotsAllowAll(),
      observedAt: OBSERVED_AT,
    });
    expect(calls).toBe(2);
    expect(out.result.jobs_count).toBe(60);
  });

  it("stops on short page (final page)", async () => {
    let calls = 0;
    server.use(
      http.get(`https://${HOST}/careers-home/api/jobs`, () => {
        calls += 1;
        return HttpResponse.json(smallFixture);
      }),
    );
    const out = await scrapeWiproTenant({
      tenant: { slug: "wipro" },
      client: clientWithRobotsAllowAll(),
      observedAt: OBSERVED_AT,
    });
    expect(calls).toBe(1);
    expect(out.result.jobs_count).toBe(1);
  });

  it("classifies 5xx as transient_failure", async () => {
    server.use(
      http.get(`https://${HOST}/careers-home/api/jobs`, () =>
        HttpResponse.text("oops", { status: 503 }),
      ),
    );
    const out = await scrapeWiproTenant({
      tenant: { slug: "wipro" },
      client: clientWithRobotsAllowAll(),
      observedAt: OBSERVED_AT,
    });
    expect(out.result.status).toBe("transient_failure");
  });
});
