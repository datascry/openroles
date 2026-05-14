import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import fc from "fast-check";
import { parseAmazonJobs, scrapeAmazonJobsTenant } from "../../src/ats/amazonjobs.ts";
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

describe("parseAmazonJobs (fixture replay)", () => {
  it("parses the small fixture into a single job with US location and AWS department", () => {
    const jobs = parseAmazonJobs({
      tenant: { slug: "amazon" },
      company: "Amazon",
      response: readFixture("amazonjobs.small.json"),
      observedAt: OBSERVED_AT,
    });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.title).toBe("Senior Software Engineer");
    expect(jobs[0]?.location_text).toBe("Seattle, Washington, US");
    expect(jobs[0]?.location_country).toBe("US");
    expect(jobs[0]?.location_region).toBe("Washington");
    expect(jobs[0]?.department).toBe("AWS");
    expect(jobs[0]?.posted_at).toBe("2026-04-10T00:00:00.000Z");
    expect(jobs[0]?.url).toBe("https://amazon.jobs/en/jobs/1234567/senior-software-engineer");
  });

  it("parses the large fixture, classifies Virtual locations as remote, flags recruiter titles", () => {
    const jobs = parseAmazonJobs({
      tenant: { slug: "amazon" },
      company: "Amazon",
      response: readFixture("amazonjobs.large.json"),
      observedAt: OBSERVED_AT,
    });
    expect(jobs).toHaveLength(3);

    // Numeric id_icims must round-trip as a string source_id (job-id
    // hashing requires string keys).
    const principal = jobs.find((j) => j.title.startsWith("Principal Engineer"));
    expect(principal?.source_id).toBe("2001");

    const recruiter = jobs.find((j) => j.title === "Technical Recruiter");
    expect(recruiter?.is_recruiter_post).toBe(true);
    expect(recruiter?.department).toBe("Human Resources");

    const remote = jobs.find((j) => j.title.includes("Software Engineer (Remote)"));
    expect(remote?.workplace_type).toBe("remote");
    expect(remote?.location_text).toBe("Virtual, US");
  });

  it("trims whitespace, drops rows missing source_id, dedupes by id", () => {
    const jobs = parseAmazonJobs({
      tenant: { slug: "amazon" },
      company: "Amazon",
      response: readFixture("amazonjobs.edge.json"),
      observedAt: OBSERVED_AT,
    });
    // 4 rows in the fixture:
    //   - 1 with whitespace title (kept after trim)
    //   - 1 with no description (kept; no description_excerpt emitted)
    //   - 1 missing source_id (entire row dropped)
    //   - 1 duplicate of #1 (deduped by job id)
    expect(jobs).toHaveLength(2);
    const trimmed = jobs.find((j) => j.source_id === "3001");
    expect(trimmed?.title).toBe("Engineer with whitespace");
    // Unparseable posted_date stays absent rather than poisoning the row.
    expect(trimmed?.posted_at).toBeUndefined();
    // location_text is "London, GB" because state is absent.
    expect(trimmed?.location_text).toBe("London, GB");
    expect(trimmed?.location_country).toBe("GB");
    expect(trimmed?.location_region).toBeUndefined();
  });

  it("returns an empty array on a job-less response", () => {
    expect(
      parseAmazonJobs({
        tenant: { slug: "amazon" },
        company: "Amazon",
        response: { hits: 0, jobs: [], error: null },
        observedAt: OBSERVED_AT,
      }),
    ).toEqual([]);
  });

  it("synthesizes a job URL when job_path is missing", () => {
    const jobs = parseAmazonJobs({
      tenant: { slug: "amazon" },
      company: "Amazon",
      response: { jobs: [{ id_icims: "9001", title: "Engineer" }] },
      observedAt: OBSERVED_AT,
    });
    expect(jobs[0]?.url).toBe("https://amazon.jobs/en/jobs/9001");
  });

  it("accepts null location fields (state, city, country_code) without dropping the row", () => {
    // Amazon's API returns null (not omitted) for these fields on roles
    // without a specific state — e.g. virtual jobs and HQ-only postings.
    // Strict z.string() rejected the whole response; nullish() lets the
    // row through and the typeof-check at use-site filters the null out.
    const jobs = parseAmazonJobs({
      tenant: { slug: "amazon" },
      company: "Amazon",
      response: {
        jobs: [
          {
            id_icims: "8001",
            title: "Principal Engineer",
            city: "Seattle",
            state: null,
            country_code: "US",
            location: "Seattle, US",
          },
        ],
      },
      observedAt: OBSERVED_AT,
    });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.location_region).toBeUndefined();
    expect(jobs[0]?.location_country).toBe("US");
  });
});

describe("parseAmazonJobs (property)", () => {
  it("is deterministic across repeated invocations on the same input", () => {
    const fixture = readFixture("amazonjobs.large.json");
    fc.assert(
      fc.property(fc.constantFrom("amazon"), (slug) => {
        const a = parseAmazonJobs({
          tenant: { slug },
          company: "Amazon",
          response: fixture,
          observedAt: OBSERVED_AT,
        });
        const b = parseAmazonJobs({
          tenant: { slug },
          company: "Amazon",
          response: fixture,
          observedAt: OBSERVED_AT,
        });
        return JSON.stringify(a) === JSON.stringify(b);
      }),
      { numRuns: 20 },
    );
  });
});

describe("scrapeAmazonJobsTenant", () => {
  it("rejects a slug other than 'amazon' without making a request", async () => {
    let calls = 0;
    server.use(
      http.get("https://amazon.jobs/en/search.json", () => {
        calls += 1;
        return HttpResponse.json({ hits: 0, jobs: [], error: null });
      }),
    );
    const out = await scrapeAmazonJobsTenant({
      tenant: { slug: "not-amazon" },
      client: clientWithRobotsAllowAll(),
      observedAt: OBSERVED_AT,
    });
    expect(out.result.status).toBe("dead");
    expect(out.result.error).toContain("single-tenant");
    expect(calls).toBe(0);
  });

  it("paginates until hits is reached", async () => {
    let calls = 0;
    server.use(
      http.get("https://amazon.jobs/en/search.json", ({ request }) => {
        calls += 1;
        const url = new URL(request.url);
        const offset = Number.parseInt(url.searchParams.get("offset") ?? "0", 10);
        if (offset === 0) {
          return HttpResponse.json({
            hits: 110,
            jobs: Array.from({ length: 100 }, (_, i) => ({
              id_icims: `${10000 + i}`,
              title: `Job ${i}`,
            })),
            error: null,
          });
        }
        return HttpResponse.json({
          hits: 110,
          jobs: Array.from({ length: 10 }, (_, i) => ({
            id_icims: `${20000 + i}`,
            title: `Job ${i}`,
          })),
          error: null,
        });
      }),
    );
    const out = await scrapeAmazonJobsTenant({
      tenant: { slug: "amazon", display_name: "Amazon" },
      client: clientWithRobotsAllowAll(),
      observedAt: OBSERVED_AT,
    });
    expect(calls).toBe(2);
    expect(out.result.status).toBe("success");
    expect(out.result.jobs_count).toBe(110);
  });

  it("stops on a short page (final page)", async () => {
    let calls = 0;
    server.use(
      http.get("https://amazon.jobs/en/search.json", () => {
        calls += 1;
        return HttpResponse.json(readFixture("amazonjobs.small.json"));
      }),
    );
    const out = await scrapeAmazonJobsTenant({
      tenant: { slug: "amazon" },
      client: clientWithRobotsAllowAll(),
      observedAt: OBSERVED_AT,
    });
    expect(calls).toBe(1);
    expect(out.result.jobs_count).toBe(1);
  });

  it("classifies 5xx as transient_failure via errorToResult", async () => {
    server.use(
      http.get("https://amazon.jobs/en/search.json", () =>
        HttpResponse.text("oops", { status: 503 }),
      ),
    );
    const out = await scrapeAmazonJobsTenant({
      tenant: { slug: "amazon" },
      client: clientWithRobotsAllowAll(),
      observedAt: OBSERVED_AT,
    });
    expect(out.result.status).toBe("transient_failure");
    expect(out.jobs).toEqual([]);
  });

  it("respects maxPages cap when hits is missing", async () => {
    let calls = 0;
    server.use(
      http.get("https://amazon.jobs/en/search.json", () => {
        calls += 1;
        return HttpResponse.json({
          jobs: Array.from({ length: 100 }, (_, i) => ({
            id_icims: `${calls}-${i}`,
            title: `Job ${calls}-${i}`,
          })),
          error: null,
        });
      }),
    );
    const out = await scrapeAmazonJobsTenant({
      tenant: { slug: "amazon" },
      client: clientWithRobotsAllowAll(),
      observedAt: OBSERVED_AT,
      maxPages: 3,
    });
    expect(calls).toBe(3);
    expect(out.result.jobs_count).toBe(300);
  });
});
