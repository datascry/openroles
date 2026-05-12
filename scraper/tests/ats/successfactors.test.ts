import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import fc from "fast-check";
import {
  assertSuccessFactorsHost,
  parseSuccessFactorsJobs,
  scrapeSuccessFactorsTenant,
} from "../../src/ats/successfactors.ts";
import {
  clientWithRobotsAllowAll,
  HttpResponse,
  http,
  makeServer,
  readFixture,
} from "../helpers.ts";

const OBSERVED_AT = "2026-04-26T00:00:00Z";
const HOST = "career4.successfactors.eu";

const server = makeServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("parseSuccessFactorsJobs (fixture replay)", () => {
  it("parses the small fixture into a single job with hybrid workplace", () => {
    const jobs = parseSuccessFactorsJobs({
      tenant: { slug: "acme" },
      company: "Acme",
      host: HOST,
      response: readFixture("successfactors.small.json"),
      observedAt: OBSERVED_AT,
    });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.title).toBe("Senior Software Engineer");
    expect(jobs[0]?.workplace_type).toBe("hybrid");
    expect(jobs[0]?.location_text).toBe("Berlin, DE");
    expect(jobs[0]?.department).toBe("Engineering");
    // URL synthesised because the fixture omits it — must include the
    // canonical career_job_req_id query parameter.
    expect(jobs[0]?.url).toBe(`https://${HOST}/career?company=acme&career_job_req_id=R-1001`);
  });

  it("parses the large fixture and preserves the API-provided job URL when present", () => {
    const jobs = parseSuccessFactorsJobs({
      tenant: { slug: "acme" },
      company: "Acme",
      host: HOST,
      response: readFixture("successfactors.large.json"),
      observedAt: OBSERVED_AT,
    });
    expect(jobs).toHaveLength(3);
    const remoteEng = jobs.find((j) => j.title === "Staff Backend Engineer");
    expect(remoteEng?.workplace_type).toBe("remote");
    // Numeric jobReqId must round-trip as a string source_id (job-id hashing
    // requires a string), so the API-provided integer 2001 becomes "2001".
    expect(remoteEng?.source_id).toBe("2001");
    const recruiter = jobs.find((j) => j.title === "Technical Recruiter");
    expect(recruiter?.is_recruiter_post).toBe(true);
    expect(recruiter?.workplace_type).toBe("onsite");
    const arch = jobs.find((j) => j.title === "Principal Architect");
    // Honor the API-provided URL when shape-safe; do NOT overwrite it
    // with a synthesised one.
    expect(arch?.url).toBe(
      "https://career4.successfactors.eu/career?company=acme&career_job_req_id=R-2003&career_ns=job_listing",
    );
  });

  it("trims whitespace, drops missing-req-id rows, and dedupes by id", () => {
    const jobs = parseSuccessFactorsJobs({
      tenant: { slug: "edge" },
      company: "Edge",
      host: HOST,
      response: readFixture("successfactors.edge.json"),
      observedAt: OBSERVED_AT,
    });
    // Of the 4 rows in the edge fixture:
    //   - 1 has whitespace title (kept after trim)
    //   - 1 has an empty department (dropped from department field, row kept)
    //   - 1 has no req id (entire row dropped)
    //   - 1 duplicates the first req id (deduped by job id)
    expect(jobs).toHaveLength(2);
    const trimmed = jobs.find((j) => j.source_id === "R-3001");
    expect(trimmed?.title).toBe("Engineer");
    // Empty-string department should not have leaked through.
    const noDept = jobs.find((j) => j.source_id === "R-3002");
    expect(noDept?.department).toBeUndefined();
    // Whitespace-only location must not surface as location_text.
    expect(trimmed?.location_text).toBeUndefined();
    expect(noDept?.location_text).toBeUndefined();
  });

  it("falls back to results[] when the response uses the alternate shape", () => {
    const jobs = parseSuccessFactorsJobs({
      tenant: { slug: "alt" },
      company: "Alt",
      host: HOST,
      response: { results: [{ jobReqId: "X1", title: "Engineer" }] },
      observedAt: OBSERVED_AT,
    });
    expect(jobs).toHaveLength(1);
  });

  it("returns an empty array for an empty response", () => {
    const jobs = parseSuccessFactorsJobs({
      tenant: { slug: "empty" },
      company: "Empty",
      host: HOST,
      response: { jobs: [], totalCount: 0 },
      observedAt: OBSERVED_AT,
    });
    expect(jobs).toEqual([]);
  });
});

describe("parseSuccessFactorsJobs (property)", () => {
  it("is deterministic across repeated invocations on the same input", () => {
    const fixture = readFixture("successfactors.large.json");
    fc.assert(
      fc.property(fc.constantFrom("a", "b"), (slug) => {
        const a = parseSuccessFactorsJobs({
          tenant: { slug },
          company: slug,
          host: HOST,
          response: fixture,
          observedAt: OBSERVED_AT,
        });
        const b = parseSuccessFactorsJobs({
          tenant: { slug },
          company: slug,
          host: HOST,
          response: fixture,
          observedAt: OBSERVED_AT,
        });
        return JSON.stringify(a) === JSON.stringify(b);
      }),
      { numRuns: 20 },
    );
  });
});

describe("assertSuccessFactorsHost", () => {
  it("accepts the documented regional datacenters", () => {
    expect(() => assertSuccessFactorsHost("career4.successfactors.eu")).not.toThrow();
    expect(() => assertSuccessFactorsHost("career2.successfactors.com")).not.toThrow();
    expect(() => assertSuccessFactorsHost("career10.successfactors.de")).not.toThrow();
    expect(() => assertSuccessFactorsHost("career44.successfactors.com.cn")).not.toThrow();
  });

  it("rejects non-SF hosts (SSRF guard)", () => {
    expect(() => assertSuccessFactorsHost("evil.example.com")).toThrow();
    expect(() => assertSuccessFactorsHost("careerx.successfactors.com")).toThrow();
    expect(() => assertSuccessFactorsHost("career4.successfactors.evil")).toThrow();
    expect(() => assertSuccessFactorsHost("")).toThrow();
  });
});

describe("scrapeSuccessFactorsTenant", () => {
  it("paginates until totalCount reached", async () => {
    let calls = 0;
    server.use(
      http.post(`https://${HOST}/careersection/rest/jobboard/search-jobs`, async ({ request }) => {
        calls += 1;
        const body = (await request.json()) as { offset: number; limit: number };
        if (body.offset === 0) {
          return HttpResponse.json({
            jobs: Array.from({ length: 50 }, (_, i) => ({
              jobReqId: `R-page0-${i}`,
              title: `Engineer ${i}`,
            })),
            totalCount: 60,
          });
        }
        return HttpResponse.json({
          jobs: Array.from({ length: 10 }, (_, i) => ({
            jobReqId: `R-page1-${i}`,
            title: `Engineer ${i}`,
          })),
          totalCount: 60,
        });
      }),
    );
    const out = await scrapeSuccessFactorsTenant({
      tenant: { slug: "acme", display_name: "Acme" },
      client: clientWithRobotsAllowAll(),
      observedAt: OBSERVED_AT,
      host: HOST,
    });
    expect(calls).toBe(2);
    expect(out.result.status).toBe("success");
    expect(out.result.jobs_count).toBe(60);
  });

  it("stops on short page (final page)", async () => {
    let calls = 0;
    server.use(
      http.post(`https://${HOST}/careersection/rest/jobboard/search-jobs`, () => {
        calls += 1;
        return HttpResponse.json(readFixture("successfactors.small.json"));
      }),
    );
    const out = await scrapeSuccessFactorsTenant({
      tenant: { slug: "acme" },
      client: clientWithRobotsAllowAll(),
      observedAt: OBSERVED_AT,
      host: HOST,
    });
    expect(calls).toBe(1);
    expect(out.result.jobs_count).toBe(1);
  });

  it("rejects an unsafe host without hitting the network", async () => {
    let calls = 0;
    server.use(
      http.post("https://evil.example.com/careersection/rest/jobboard/search-jobs", () => {
        calls += 1;
        return HttpResponse.json({ jobs: [] });
      }),
    );
    const out = await scrapeSuccessFactorsTenant({
      tenant: { slug: "acme" },
      client: clientWithRobotsAllowAll(),
      observedAt: OBSERVED_AT,
      host: "evil.example.com",
    });
    expect(out.result.status).toBe("dead");
    expect(out.result.jobs_count).toBe(0);
    expect(calls).toBe(0);
  });

  it("propagates a server error as transient_failure via errorToResult", async () => {
    server.use(
      http.post(`https://${HOST}/careersection/rest/jobboard/search-jobs`, () =>
        HttpResponse.text("oops", { status: 503 }),
      ),
    );
    const out = await scrapeSuccessFactorsTenant({
      tenant: { slug: "acme" },
      client: clientWithRobotsAllowAll(),
      observedAt: OBSERVED_AT,
      host: HOST,
    });
    expect(out.result.status).toBe("transient_failure");
    expect(out.jobs).toEqual([]);
  });

  it("respects maxPages cap when totalCount is missing", async () => {
    let calls = 0;
    server.use(
      http.post(`https://${HOST}/careersection/rest/jobboard/search-jobs`, () => {
        calls += 1;
        return HttpResponse.json({
          jobs: Array.from({ length: 50 }, (_, i) => ({
            jobReqId: `R-${calls}-${i}`,
            title: `Engineer ${calls}-${i}`,
          })),
        });
      }),
    );
    const out = await scrapeSuccessFactorsTenant({
      tenant: { slug: "acme" },
      client: clientWithRobotsAllowAll(),
      observedAt: OBSERVED_AT,
      host: HOST,
      maxPages: 3,
    });
    expect(calls).toBe(3);
    expect(out.result.jobs_count).toBe(150);
  });
});
