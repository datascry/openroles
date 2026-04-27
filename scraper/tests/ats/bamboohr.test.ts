import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from "bun:test";
import fc from "fast-check";
import { parseBambooJobs, scrapeBambooTenant } from "../../src/ats/bamboohr.ts";
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

const server = makeServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("parseBambooJobs (fixture replay)", () => {
  it("parses the large fixture", () => {
    const jobs = parseBambooJobs({
      tenant: { slug: "example" },
      company: "Example",
      response: readFixture("bamboohr.large.json"),
      observedAt: OBSERVED_AT,
    });
    expect(jobs).toHaveLength(3);
    const remote = jobs.find((j) => j.title === "Director of People");
    expect(remote?.workplace_type).toBe("remote");
    expect(remote?.location_country).toBe("US");
    const sourcer = jobs.find((j) => j.title === "Talent Sourcer");
    expect(sourcer?.is_recruiter_post).toBe(true);
    expect(sourcer?.location_country).toBe("GB");
  });

  it("parses the small fixture", () => {
    const jobs = parseBambooJobs({
      tenant: { slug: "tinyco" },
      company: "tinyco",
      response: readFixture("bamboohr.small.json"),
      observedAt: OBSERVED_AT,
    });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.posted_at).toBe("2026-04-01T00:00:00Z");
  });

  it("parses the edge fixture: dedupes by id, handles missing fields", () => {
    const jobs = parseBambooJobs({
      tenant: { slug: "edge" },
      company: "Edge",
      response: readFixture("bamboohr.edge.json"),
      observedAt: OBSERVED_AT,
    });
    expect(jobs).toHaveLength(2);
    const noDesc = jobs.find((j) => j.source_id === "100");
    expect(noDesc?.posted_at).toBe("2026-04-22T12:00:00Z");
    const direct = jobs.find((j) => j.source_id === "101");
    expect(direct?.location_country).toBe("DE");
    expect(direct?.posted_at).toBeUndefined();
  });
});

describe("parseBambooJobs (property)", () => {
  it("is deterministic on identical input", () => {
    const fixture = readFixture("bamboohr.large.json");
    fc.assert(
      fc.property(fc.constantFrom("a", "b"), (slug) => {
        const a = parseBambooJobs({
          tenant: { slug },
          company: slug,
          response: fixture,
          observedAt: OBSERVED_AT,
        });
        const b = parseBambooJobs({
          tenant: { slug },
          company: slug,
          response: fixture,
          observedAt: OBSERVED_AT,
        });
        return JSON.stringify(a) === JSON.stringify(b);
      }),
      { numRuns: 20 },
    );
  });
});

describe("scrapeBambooTenant", () => {
  it("hits the careers/list endpoint and returns success", async () => {
    server.use(
      http.get("https://example.bamboohr.com/careers/list", () =>
        HttpResponse.json(readFixture("bamboohr.small.json")),
      ),
    );
    const client = clientWithRobotsAllowAll();
    const out = await scrapeBambooTenant({
      tenant: { slug: "example" },
      client,
      observedAt: OBSERVED_AT,
    });
    expect(out.result.status).toBe("success");
    expect(out.result.jobs_count).toBe(1);
  });

  it("retries on 5xx", async () => {
    let attempts = 0;
    server.use(
      http.get("https://flake.bamboohr.com/careers/list", () => {
        attempts += 1;
        if (attempts < 2) return new HttpResponse("err", { status: 503 });
        return HttpResponse.json(readFixture("bamboohr.small.json"));
      }),
    );
    const client = clientWithRobotsAllowAll();
    const out = await scrapeBambooTenant({
      tenant: { slug: "flake" },
      client,
      observedAt: OBSERVED_AT,
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
    const out = await scrapeBambooTenant({
      tenant: { slug: "blocked" },
      client,
      observedAt: OBSERVED_AT,
    });
    expect(out.result.status).toBe("dead");
  });
});
