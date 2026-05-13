import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import fc from "fast-check";
import { parseMetaJobs, scrapeMetaCareersTenant } from "../../src/ats/metacareers.ts";
import {
  clientWithRobotsAllowAll,
  HttpResponse,
  http,
  makeServer,
  readFixture,
} from "../helpers.ts";

const OBSERVED_AT = "2026-04-26T00:00:00Z";

const server = makeServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("parseMetaJobs (fixture replay)", () => {
  it("parses the small fixture and honors the API-provided URL", () => {
    const jobs = parseMetaJobs({
      tenant: { slug: "meta" },
      company: "Meta",
      response: readFixture("metacareers.small.json"),
      observedAt: OBSERVED_AT,
    });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.title).toBe("Software Engineer, Reality Labs");
    expect(jobs[0]?.location_text).toBe("Menlo Park, CA");
    expect(jobs[0]?.location_country).toBe("US");
    expect(jobs[0]?.location_region).toBe("California");
    expect(jobs[0]?.department).toBe("Reality Labs");
    expect(jobs[0]?.posted_at).toBe("2026-04-10T00:00:00.000Z");
    expect(jobs[0]?.url).toBe("https://www.metacareers.com/jobs/1234567890/");
  });

  it("parses the large fixture, flags recruiter titles, classifies remote", () => {
    const jobs = parseMetaJobs({
      tenant: { slug: "meta" },
      company: "Meta",
      response: readFixture("metacareers.large.json"),
      observedAt: OBSERVED_AT,
    });
    expect(jobs).toHaveLength(3);

    const recruiter = jobs.find((j) => j.title === "Technical Recruiter");
    expect(recruiter?.is_recruiter_post).toBe(true);
    expect(recruiter?.department).toBe("People");
    expect(recruiter?.location_country).toBe("GB");

    const remote = jobs.find((j) => j.title.includes("(Remote)"));
    expect(remote?.workplace_type).toBe("remote");
  });

  it("derives source_id from url when the explicit id is missing, drops id-less rows, dedupes", () => {
    const jobs = parseMetaJobs({
      tenant: { slug: "meta" },
      company: "Meta",
      response: readFixture("metacareers.edge.json"),
      observedAt: OBSERVED_AT,
    });
    // 4 rows:
    //   - 1 with whitespace title + url-derived id (5555555555)
    //   - 1 with no locations (kept; no location fields emitted)
    //   - 1 with neither id nor url (dropped)
    //   - 1 with different explicit id but SAME url-derived numeric →
    //     becomes the same job id via url; dedupes
    // Actually: the duplicate has an explicit id "v1-5555555555-dup", so
    // its sourceId will be that, not the url-derived numeric. So it
    // stays. End count is 3.
    expect(jobs).toHaveLength(3);
    const trimmed = jobs.find((j) => j.source_id === "5555555555");
    expect(trimmed?.title).toBe("Engineer with whitespace and id-from-url");
    expect(trimmed?.url).toBe("https://www.metacareers.com/jobs/5555555555/");
    // Unparseable posted_date stays absent.
    expect(trimmed?.posted_at).toBeUndefined();
    // No-locations row must not emit location fields.
    const noLoc = jobs.find((j) => j.source_id === "v1-6666666666");
    expect(noLoc?.location_text).toBeUndefined();
  });

  it("synthesizes a job URL when the API-provided url is not a metacareers.com host (SSRF guard)", () => {
    const jobs = parseMetaJobs({
      tenant: { slug: "meta" },
      company: "Meta",
      response: {
        jobs: [{ id: "v1-9999", title: "Engineer", url: "https://evil.example.com/jobs/9999/" }],
      },
      observedAt: OBSERVED_AT,
    });
    expect(jobs[0]?.url).toBe("https://www.metacareers.com/jobs/v1-9999/");
  });

  it("falls back to results[] when the response uses the alternate shape", () => {
    const jobs = parseMetaJobs({
      tenant: { slug: "meta" },
      company: "Meta",
      response: {
        results: [
          { id: "v1-9001", title: "Engineer", url: "https://www.metacareers.com/jobs/9001/" },
        ],
      },
      observedAt: OBSERVED_AT,
    });
    expect(jobs).toHaveLength(1);
  });

  it("returns [] on empty jobs", () => {
    expect(
      parseMetaJobs({
        tenant: { slug: "meta" },
        company: "Meta",
        response: { total_results: 0, jobs: [] },
        observedAt: OBSERVED_AT,
      }),
    ).toEqual([]);
  });
});

describe("parseMetaJobs (property)", () => {
  it("is deterministic across repeated invocations on the same input", () => {
    const fixture = readFixture("metacareers.large.json");
    fc.assert(
      fc.property(fc.constantFrom("meta"), (slug) => {
        const a = parseMetaJobs({
          tenant: { slug },
          company: "Meta",
          response: fixture,
          observedAt: OBSERVED_AT,
        });
        const b = parseMetaJobs({
          tenant: { slug },
          company: "Meta",
          response: fixture,
          observedAt: OBSERVED_AT,
        });
        return JSON.stringify(a) === JSON.stringify(b);
      }),
      { numRuns: 20 },
    );
  });
});

describe("scrapeMetaCareersTenant", () => {
  it("rejects a slug other than 'meta' without making a request", async () => {
    let calls = 0;
    server.use(
      http.post("https://www.metacareers.com/api/jobs", () => {
        calls += 1;
        return HttpResponse.json({ total_results: 0, jobs: [] });
      }),
    );
    const out = await scrapeMetaCareersTenant({
      tenant: { slug: "not-meta" },
      client: clientWithRobotsAllowAll(),
      observedAt: OBSERVED_AT,
    });
    expect(out.result.status).toBe("dead");
    expect(out.result.error).toContain("single-tenant");
    expect(calls).toBe(0);
  });

  it("paginates until total_results is reached", async () => {
    let calls = 0;
    server.use(
      http.post("https://www.metacareers.com/api/jobs", async ({ request }) => {
        calls += 1;
        const body = (await request.json()) as { page: number; results_per_page: number };
        if (body.page === 1) {
          return HttpResponse.json({
            total_results: 60,
            jobs: Array.from({ length: 50 }, (_, i) => ({
              id: `v1-${10000 + i}`,
              title: `Engineer ${i}`,
              url: `https://www.metacareers.com/jobs/${10000 + i}/`,
            })),
          });
        }
        return HttpResponse.json({
          total_results: 60,
          jobs: Array.from({ length: 10 }, (_, i) => ({
            id: `v1-${20000 + i}`,
            title: `Engineer ${i}`,
            url: `https://www.metacareers.com/jobs/${20000 + i}/`,
          })),
        });
      }),
    );
    const out = await scrapeMetaCareersTenant({
      tenant: { slug: "meta", display_name: "Meta" },
      client: clientWithRobotsAllowAll(),
      observedAt: OBSERVED_AT,
    });
    expect(calls).toBe(2);
    expect(out.result.status).toBe("success");
    expect(out.result.jobs_count).toBe(60);
  });

  it("stops on a short page (final page)", async () => {
    let calls = 0;
    server.use(
      http.post("https://www.metacareers.com/api/jobs", () => {
        calls += 1;
        return HttpResponse.json(readFixture("metacareers.small.json"));
      }),
    );
    const out = await scrapeMetaCareersTenant({
      tenant: { slug: "meta" },
      client: clientWithRobotsAllowAll(),
      observedAt: OBSERVED_AT,
    });
    expect(calls).toBe(1);
    expect(out.result.jobs_count).toBe(1);
  });

  it("classifies 5xx as transient_failure", async () => {
    server.use(
      http.post("https://www.metacareers.com/api/jobs", () =>
        HttpResponse.text("oops", { status: 503 }),
      ),
    );
    const out = await scrapeMetaCareersTenant({
      tenant: { slug: "meta" },
      client: clientWithRobotsAllowAll(),
      observedAt: OBSERVED_AT,
    });
    expect(out.result.status).toBe("transient_failure");
  });
});
