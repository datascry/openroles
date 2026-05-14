import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import fc from "fast-check";
import { assertPhenomHost, parsePhenomJobs, scrapePhenomTenant } from "../../src/ats/phenom.ts";
import {
  clientWithRobotsAllowAll,
  HttpResponse,
  http,
  makeServer,
  readFixture,
} from "../helpers.ts";

const OBSERVED_AT = "2026-04-26T00:00:00Z";
const HOST = "jobs.walgreens.com";

const server = makeServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("parsePhenomJobs (fixture replay)", () => {
  it("parses the small fixture and honors the API-provided URL", () => {
    const jobs = parsePhenomJobs({
      tenant: { slug: "walgreens" },
      company: "Walgreens",
      host: HOST,
      response: readFixture("phenom.small.json"),
      observedAt: OBSERVED_AT,
    });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.title).toBe("Senior Pharmacist");
    // When `location` field is absent, the parser composes
    // "{city}, {state}, {country-name}" from the structured fields.
    expect(jobs[0]?.location_text).toBe("Chicago, Illinois, United States");
    expect(jobs[0]?.location_country).toBe("US");
    expect(jobs[0]?.location_region).toBe("Illinois");
    expect(jobs[0]?.department).toBe("Pharmacy Services");
    expect(jobs[0]?.url).toBe("https://jobs.walgreens.com/job/chicago/senior-pharmacist/12345");
  });

  it("parses the large fixture, handles ats_job_id alias, classifies Remote", () => {
    const jobs = parsePhenomJobs({
      tenant: { slug: "bp" },
      company: "BP",
      host: "careers.bp.com",
      response: readFixture("phenom.large.json"),
      observedAt: OBSERVED_AT,
    });
    expect(jobs).toHaveLength(3);

    // Numeric jobId rounds to string source_id.
    const principal = jobs.find((j) => j.title.startsWith("Principal Petroleum"));
    expect(principal?.source_id).toBe("67001");
    expect(principal?.department).toBe("Upstream");

    // ats_job_id is the alias fallback for jobId.
    const recruiter = jobs.find((j) => j.title === "Technical Recruiter");
    expect(recruiter?.source_id).toBe("67002");
    expect(recruiter?.is_recruiter_post).toBe(true);
    // Department falls back to `category` when `department` is absent.
    expect(recruiter?.department).toBe("Human Resources");

    const remote = jobs.find((j) => j.title.includes("(Remote)"));
    expect(remote?.workplace_type).toBe("remote");
    // apply_url is honored when it points at the customer host
    // (matches the same-host SSRF guard for the `url` field).
    expect(remote?.url).toBe("https://careers.bp.com/apply/67003");
  });

  it("trims whitespace, drops missing-id rows, dedupes by job id", () => {
    const jobs = parsePhenomJobs({
      tenant: { slug: "edge" },
      company: "Edge",
      host: HOST,
      response: readFixture("phenom.edge.json"),
      observedAt: OBSERVED_AT,
    });
    expect(jobs).toHaveLength(2);
    const trimmed = jobs.find((j) => j.source_id === "ED1");
    expect(trimmed?.title).toBe("Engineer with whitespace");
    expect(trimmed?.posted_at).toBeUndefined();
    const noLoc = jobs.find((j) => j.source_id === "ED2");
    // location_text becomes the country name since city/state absent
    expect(noLoc?.location_country).toBe("DE");
  });

  it("synthesizes job URL when API URL points off-host (SSRF guard)", () => {
    const jobs = parsePhenomJobs({
      tenant: { slug: "walgreens" },
      company: "Walgreens",
      host: HOST,
      response: {
        jobs: [{ jobId: "X1", title: "Engineer", url: "https://evil.example.com/jobs/X1" }],
      },
      observedAt: OBSERVED_AT,
    });
    expect(jobs[0]?.url).toBe(`https://${HOST}/job/X1`);
  });

  it("falls back to results[] when the response uses the alternate shape", () => {
    const jobs = parsePhenomJobs({
      tenant: { slug: "alt" },
      company: "Alt",
      host: HOST,
      response: { results: [{ jobId: "X1", title: "Engineer" }] },
      observedAt: OBSERVED_AT,
    });
    expect(jobs).toHaveLength(1);
  });

  it("returns [] on empty response", () => {
    expect(
      parsePhenomJobs({
        tenant: { slug: "empty" },
        company: "Empty",
        host: HOST,
        response: { total: 0, jobs: [] },
        observedAt: OBSERVED_AT,
      }),
    ).toEqual([]);
  });
});

describe("parsePhenomJobs (property)", () => {
  it("is deterministic across repeated invocations on the same input", () => {
    const fixture = readFixture("phenom.large.json");
    fc.assert(
      fc.property(fc.constantFrom("bp"), (slug) => {
        const a = parsePhenomJobs({
          tenant: { slug },
          company: "BP",
          host: "careers.bp.com",
          response: fixture,
          observedAt: OBSERVED_AT,
        });
        const b = parsePhenomJobs({
          tenant: { slug },
          company: "BP",
          host: "careers.bp.com",
          response: fixture,
          observedAt: OBSERVED_AT,
        });
        return JSON.stringify(a) === JSON.stringify(b);
      }),
      { numRuns: 20 },
    );
  });
});

describe("assertPhenomHost", () => {
  it("accepts well-formed customer hostnames", () => {
    expect(() => assertPhenomHost("jobs.walgreens.com")).not.toThrow();
    expect(() => assertPhenomHost("careers.bp.com")).not.toThrow();
    expect(() => assertPhenomHost("jobs.cvshealth.com")).not.toThrow();
    expect(() => assertPhenomHost("jobs.gap.com")).not.toThrow();
  });

  it("rejects private / loopback / malformed hosts (SSRF guard)", () => {
    expect(() => assertPhenomHost("")).toThrow();
    expect(() => assertPhenomHost("localhost")).toThrow();
    expect(() => assertPhenomHost("foo.localhost")).toThrow();
    expect(() => assertPhenomHost("foo.internal")).toThrow();
    expect(() => assertPhenomHost("foo.local")).toThrow();
    expect(() => assertPhenomHost("UPPER.CASE")).toThrow();
    expect(() => assertPhenomHost("--leading.dash.com")).toThrow();
    // Length cap (DNS label/host max)
    expect(() => assertPhenomHost("a".repeat(254))).toThrow();
  });
});

describe("scrapePhenomTenant", () => {
  it("paginates until total is reached", async () => {
    let calls = 0;
    server.use(
      http.get(`https://${HOST}/api/jobs`, ({ request }) => {
        calls += 1;
        const url = new URL(request.url);
        const page = Number.parseInt(url.searchParams.get("page") ?? "1", 10);
        if (page === 1) {
          return HttpResponse.json({
            total: 60,
            jobs: Array.from({ length: 50 }, (_, i) => ({
              jobId: `R-page1-${i}`,
              title: `Pharmacist ${i}`,
            })),
          });
        }
        return HttpResponse.json({
          total: 60,
          jobs: Array.from({ length: 10 }, (_, i) => ({
            jobId: `R-page2-${i}`,
            title: `Pharmacist ${i}`,
          })),
        });
      }),
    );
    const out = await scrapePhenomTenant({
      tenant: { slug: "walgreens", display_name: "Walgreens" },
      client: clientWithRobotsAllowAll(),
      observedAt: OBSERVED_AT,
      host: HOST,
    });
    expect(calls).toBe(2);
    expect(out.result.status).toBe("success");
    expect(out.result.jobs_count).toBe(60);
  });

  it("rejects an unsafe host without making a request", async () => {
    let calls = 0;
    server.use(
      http.get("https://localhost/api/jobs", () => {
        calls += 1;
        return HttpResponse.json({ total: 0, jobs: [] });
      }),
    );
    const out = await scrapePhenomTenant({
      tenant: { slug: "walgreens" },
      client: clientWithRobotsAllowAll(),
      observedAt: OBSERVED_AT,
      host: "localhost",
    });
    expect(out.result.status).toBe("dead");
    expect(calls).toBe(0);
  });

  it("stops on a short page (final page)", async () => {
    let calls = 0;
    server.use(
      http.get(`https://${HOST}/api/jobs`, () => {
        calls += 1;
        return HttpResponse.json(readFixture("phenom.small.json"));
      }),
    );
    const out = await scrapePhenomTenant({
      tenant: { slug: "walgreens" },
      client: clientWithRobotsAllowAll(),
      observedAt: OBSERVED_AT,
      host: HOST,
    });
    expect(calls).toBe(1);
    expect(out.result.jobs_count).toBe(1);
  });

  it("classifies 5xx as transient_failure", async () => {
    server.use(
      http.get(`https://${HOST}/api/jobs`, () => HttpResponse.text("oops", { status: 503 })),
    );
    const out = await scrapePhenomTenant({
      tenant: { slug: "walgreens" },
      client: clientWithRobotsAllowAll(),
      observedAt: OBSERVED_AT,
      host: HOST,
    });
    expect(out.result.status).toBe("transient_failure");
  });
});
