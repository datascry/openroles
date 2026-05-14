import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import fc from "fast-check";
import { parseAppleJobs, scrapeAppleJobsTenant } from "../../src/ats/applejobs.ts";
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

describe("parseAppleJobs (fixture replay)", () => {
  it("parses the small fixture and extracts Cupertino location with region", () => {
    const jobs = parseAppleJobs({
      tenant: { slug: "apple" },
      company: "Apple",
      response: readFixture("applejobs.small.json"),
      observedAt: OBSERVED_AT,
    });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.title).toBe("Senior Software Engineer");
    expect(jobs[0]?.location_text).toBe("Cupertino, California, United States");
    // The middle slot in a 3-part comma-separated location string is the
    // region (state/province) by Apple's convention.
    expect(jobs[0]?.location_region).toBe("California");
    expect(jobs[0]?.department).toBe("Software and Services");
    expect(jobs[0]?.posted_at).toBe("2026-04-10T00:00:00.000Z");
    expect(jobs[0]?.url).toBe("https://jobs.apple.com/en-us/details/200512345");
  });

  it("parses the large fixture, classifies homeOffice=true as remote, flags recruiter titles", () => {
    const jobs = parseAppleJobs({
      tenant: { slug: "apple" },
      company: "Apple",
      response: readFixture("applejobs.large.json"),
      observedAt: OBSERVED_AT,
    });
    expect(jobs).toHaveLength(3);

    // Numeric positionId round-trips as string source_id (job-id hashing
    // requires string keys).
    const arch = jobs.find((j) => j.title.startsWith("Principal Architect"));
    expect(arch?.source_id).toBe("200612001");
    expect(arch?.location_country).toBe("US");

    const recruiter = jobs.find((j) => j.title === "Technical Recruiter");
    expect(recruiter?.is_recruiter_post).toBe(true);
    expect(recruiter?.department).toBe("People");

    const remote = jobs.find((j) => j.title.includes("Software Engineer (Remote)"));
    expect(remote?.workplace_type).toBe("remote");
  });

  it("trims whitespace, drops missing-id rows, dedupes by job id", () => {
    const jobs = parseAppleJobs({
      tenant: { slug: "apple" },
      company: "Apple",
      response: readFixture("applejobs.edge.json"),
      observedAt: OBSERVED_AT,
    });
    expect(jobs).toHaveLength(2);
    const trimmed = jobs.find((j) => j.source_id === "200712001");
    expect(trimmed?.title).toBe("Engineer with whitespace");
    // Unparseable postingDate stays absent.
    expect(trimmed?.posted_at).toBeUndefined();
    expect(trimmed?.location_region).toBe("England");
    // Missing locations entry must not emit location fields.
    const noLoc = jobs.find((j) => j.source_id === "200712002");
    expect(noLoc?.location_text).toBeUndefined();
  });

  it("returns empty on empty searchResults", () => {
    const jobs = parseAppleJobs({
      tenant: { slug: "apple" },
      company: "Apple",
      response: { totalRecords: 0, searchResults: [] },
      observedAt: OBSERVED_AT,
    });
    expect(jobs).toEqual([]);
  });

  it("location_region stays undefined for 2-part location strings", () => {
    const jobs = parseAppleJobs({
      tenant: { slug: "apple" },
      company: "Apple",
      response: {
        searchResults: [
          {
            positionId: "X1",
            postingTitle: "Engineer",
            locations: [{ name: "London, United Kingdom" }],
          },
        ],
      },
      observedAt: OBSERVED_AT,
    });
    expect(jobs[0]?.location_text).toBe("London, United Kingdom");
    expect(jobs[0]?.location_region).toBeUndefined();
  });
});

describe("parseAppleJobs (property)", () => {
  it("is deterministic across repeated invocations on the same input", () => {
    const fixture = readFixture("applejobs.large.json");
    fc.assert(
      fc.property(fc.constantFrom("apple"), (slug) => {
        const a = parseAppleJobs({
          tenant: { slug },
          company: "Apple",
          response: fixture,
          observedAt: OBSERVED_AT,
        });
        const b = parseAppleJobs({
          tenant: { slug },
          company: "Apple",
          response: fixture,
          observedAt: OBSERVED_AT,
        });
        return JSON.stringify(a) === JSON.stringify(b);
      }),
      { numRuns: 20 },
    );
  });
});

describe("scrapeAppleJobsTenant", () => {
  it("rejects a slug other than 'apple' without making a request", async () => {
    let calls = 0;
    server.use(
      http.post("https://jobs.apple.com/api/role/search", () => {
        calls += 1;
        return HttpResponse.json({ totalRecords: 0, searchResults: [] });
      }),
    );
    const out = await scrapeAppleJobsTenant({
      tenant: { slug: "not-apple" },
      client: clientWithRobotsAllowAll(),
      observedAt: OBSERVED_AT,
    });
    expect(out.result.status).toBe("dead");
    expect(out.result.error).toContain("single-tenant");
    expect(calls).toBe(0);
  });

  it("paginates until totalRecords is reached", async () => {
    let calls = 0;
    server.use(
      http.post("https://jobs.apple.com/api/role/search", async ({ request }) => {
        calls += 1;
        const body = (await request.json()) as { page: number };
        if (body.page === 1) {
          return HttpResponse.json({
            totalRecords: 110,
            pageSize: 100,
            searchResults: Array.from({ length: 100 }, (_, i) => ({
              positionId: `${10000 + i}`,
              postingTitle: `Engineer ${i}`,
            })),
          });
        }
        return HttpResponse.json({
          totalRecords: 110,
          pageSize: 100,
          searchResults: Array.from({ length: 10 }, (_, i) => ({
            positionId: `${20000 + i}`,
            postingTitle: `Engineer ${i}`,
          })),
        });
      }),
    );
    const out = await scrapeAppleJobsTenant({
      tenant: { slug: "apple", display_name: "Apple" },
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
      http.post("https://jobs.apple.com/api/role/search", () => {
        calls += 1;
        return HttpResponse.json(readFixture("applejobs.small.json"));
      }),
    );
    const out = await scrapeAppleJobsTenant({
      tenant: { slug: "apple" },
      client: clientWithRobotsAllowAll(),
      observedAt: OBSERVED_AT,
    });
    expect(calls).toBe(1);
    expect(out.result.jobs_count).toBe(1);
  });

  it("classifies 5xx as transient_failure", async () => {
    server.use(
      http.post("https://jobs.apple.com/api/role/search", () =>
        HttpResponse.text("oops", { status: 503 }),
      ),
    );
    const out = await scrapeAppleJobsTenant({
      tenant: { slug: "apple" },
      client: clientWithRobotsAllowAll(),
      observedAt: OBSERVED_AT,
    });
    expect(out.result.status).toBe("transient_failure");
  });
});
