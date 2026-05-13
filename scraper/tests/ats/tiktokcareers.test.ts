import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import fc from "fast-check";
import { parseTiktokJobs, scrapeTiktokCareersTenant } from "../../src/ats/tiktokcareers.ts";
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

describe("parseTiktokJobs (fixture replay)", () => {
  it("parses the small fixture and converts unix publish_time to ISO", () => {
    const jobs = parseTiktokJobs({
      tenant: { slug: "tiktok" },
      company: "TikTok",
      response: readFixture("tiktokcareers.small.json"),
      observedAt: OBSERVED_AT,
    });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.title).toBe("Software Engineer, Recommendation Algorithm");
    expect(jobs[0]?.location_text).toBe("Seattle, United States");
    expect(jobs[0]?.location_country).toBe("US");
    expect(jobs[0]?.department).toBe("Engineering");
    // 1712592000 epoch s = 2024-04-08T16:00:00.000Z (the publish_time
    // in the fixture maps cleanly to ISO; assert the exact result so
    // any future timezone regression surfaces).
    expect(jobs[0]?.posted_at).toBe("2024-04-08T16:00:00.000Z");
    expect(jobs[0]?.url).toBe("https://careers.tiktok.com/position/7283456789012345678/detail");
  });

  it("parses the large fixture, accepts numeric/string publish_time, flags recruiter titles", () => {
    const jobs = parseTiktokJobs({
      tenant: { slug: "tiktok" },
      company: "TikTok",
      response: readFixture("tiktokcareers.large.json"),
      observedAt: OBSERVED_AT,
    });
    expect(jobs).toHaveLength(3);

    // Numeric id round-trips as string source_id. TikTok's real IDs are
    // 64-bit snowflakes that exceed Number.MAX_SAFE_INTEGER and arrive as
    // JSON strings; this fixture uses a small numeric id specifically to
    // exercise the number → String() coercion path without losing precision.
    const principal = jobs.find((j) => j.title.startsWith("Principal Engineer"));
    expect(principal?.source_id).toBe("1234567");
    expect(principal?.posted_at).toBeDefined();

    const recruiter = jobs.find((j) => j.title === "Technical Recruiter");
    expect(recruiter?.is_recruiter_post).toBe(true);
    expect(recruiter?.department).toBe("People Operations");

    const remote = jobs.find((j) => j.title.includes("Backend Engineer (Remote)"));
    expect(remote?.workplace_type).toBe("remote");
    // job_function falls back to department when job_category is absent.
    expect(remote?.department).toBe("Backend");
  });

  it("trims whitespace, drops missing-id rows, dedupes by job id, rejects negative publish_time", () => {
    const jobs = parseTiktokJobs({
      tenant: { slug: "tiktok" },
      company: "TikTok",
      response: readFixture("tiktokcareers.edge.json"),
      observedAt: OBSERVED_AT,
    });
    expect(jobs).toHaveLength(2);
    const trimmed = jobs.find((j) => j.source_id === "7283456789012346001");
    expect(trimmed?.title).toBe("Engineer with whitespace");
    expect(trimmed?.posted_at).toBeUndefined();
    expect(trimmed?.location_country).toBe("GB");
  });

  it("returns [] when the envelope reports a non-zero error code", () => {
    const jobs = parseTiktokJobs({
      tenant: { slug: "tiktok" },
      company: "TikTok",
      response: { code: 40001, data: { count: 0, job_post_list: [] } },
      observedAt: OBSERVED_AT,
    });
    expect(jobs).toEqual([]);
  });

  it("returns [] on an empty job_post_list", () => {
    const jobs = parseTiktokJobs({
      tenant: { slug: "tiktok" },
      company: "TikTok",
      response: { code: 0, data: { count: 0, job_post_list: [] } },
      observedAt: OBSERVED_AT,
    });
    expect(jobs).toEqual([]);
  });
});

describe("parseTiktokJobs (property)", () => {
  it("is deterministic across repeated invocations on the same input", () => {
    const fixture = readFixture("tiktokcareers.large.json");
    fc.assert(
      fc.property(fc.constantFrom("tiktok"), (slug) => {
        const a = parseTiktokJobs({
          tenant: { slug },
          company: "TikTok",
          response: fixture,
          observedAt: OBSERVED_AT,
        });
        const b = parseTiktokJobs({
          tenant: { slug },
          company: "TikTok",
          response: fixture,
          observedAt: OBSERVED_AT,
        });
        return JSON.stringify(a) === JSON.stringify(b);
      }),
      { numRuns: 20 },
    );
  });
});

describe("scrapeTiktokCareersTenant", () => {
  it("rejects a slug other than 'tiktok' without making a request", async () => {
    let calls = 0;
    server.use(
      http.post("https://careers.tiktok.com/api/v1/search/job/posts", () => {
        calls += 1;
        return HttpResponse.json({ code: 0, data: { count: 0, job_post_list: [] } });
      }),
    );
    const out = await scrapeTiktokCareersTenant({
      tenant: { slug: "not-tiktok" },
      client: clientWithRobotsAllowAll(),
      observedAt: OBSERVED_AT,
    });
    expect(out.result.status).toBe("dead");
    expect(out.result.error).toContain("single-tenant");
    expect(calls).toBe(0);
  });

  it("paginates until count is reached", async () => {
    let calls = 0;
    server.use(
      http.post("https://careers.tiktok.com/api/v1/search/job/posts", async ({ request }) => {
        calls += 1;
        const body = (await request.json()) as { offset: number; limit: number };
        if (body.offset === 0) {
          return HttpResponse.json({
            code: 0,
            data: {
              count: 60,
              job_post_list: Array.from({ length: 50 }, (_, i) => ({
                id: `${10000 + i}`,
                title: `Engineer ${i}`,
              })),
            },
          });
        }
        return HttpResponse.json({
          code: 0,
          data: {
            count: 60,
            job_post_list: Array.from({ length: 10 }, (_, i) => ({
              id: `${20000 + i}`,
              title: `Engineer ${i}`,
            })),
          },
        });
      }),
    );
    const out = await scrapeTiktokCareersTenant({
      tenant: { slug: "tiktok", display_name: "TikTok" },
      client: clientWithRobotsAllowAll(),
      observedAt: OBSERVED_AT,
    });
    expect(calls).toBe(2);
    expect(out.result.status).toBe("success");
    expect(out.result.jobs_count).toBe(60);
  });

  it("treats a non-zero envelope code as failure (dead)", async () => {
    server.use(
      http.post("https://careers.tiktok.com/api/v1/search/job/posts", () =>
        HttpResponse.json({ code: 40001, data: { count: 0, job_post_list: [] } }),
      ),
    );
    const out = await scrapeTiktokCareersTenant({
      tenant: { slug: "tiktok" },
      client: clientWithRobotsAllowAll(),
      observedAt: OBSERVED_AT,
    });
    expect(out.result.status).toBe("dead");
    expect(out.result.error).toContain("tiktok api error");
  });

  it("classifies 5xx as transient_failure", async () => {
    server.use(
      http.post("https://careers.tiktok.com/api/v1/search/job/posts", () =>
        HttpResponse.text("oops", { status: 503 }),
      ),
    );
    const out = await scrapeTiktokCareersTenant({
      tenant: { slug: "tiktok" },
      client: clientWithRobotsAllowAll(),
      observedAt: OBSERVED_AT,
    });
    expect(out.result.status).toBe("transient_failure");
  });

  it("stops on a short page (final page)", async () => {
    let calls = 0;
    server.use(
      http.post("https://careers.tiktok.com/api/v1/search/job/posts", () => {
        calls += 1;
        return HttpResponse.json(readFixture("tiktokcareers.small.json"));
      }),
    );
    const out = await scrapeTiktokCareersTenant({
      tenant: { slug: "tiktok" },
      client: clientWithRobotsAllowAll(),
      observedAt: OBSERVED_AT,
    });
    expect(calls).toBe(1);
    expect(out.result.jobs_count).toBe(1);
  });
});
