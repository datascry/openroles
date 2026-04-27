import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from "bun:test";
import fc from "fast-check";
import { parseGreenhouseJobs, scrapeGreenhouseTenant } from "../../src/ats/greenhouse.ts";
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

describe("parseGreenhouseJobs (fixture replay)", () => {
  it("parses the large fixture into validated Jobs", () => {
    const jobs = parseGreenhouseJobs({
      tenant: { slug: "example", display_name: "Example" },
      company: "Example",
      response: readFixture("greenhouse.large.json"),
      observedAt: OBSERVED_AT,
    });
    expect(jobs).toHaveLength(5);
    expect(jobs.map((j) => j.title)).toEqual([
      "Senior Software Engineer, Payments",
      "Staff Software Engineer, Risk",
      "Engineering Manager, Platform",
      "Technical Recruiter",
      "Junior Frontend Engineer",
    ]);
    const recruiter = jobs.find((j) => j.title === "Technical Recruiter");
    expect(recruiter?.is_recruiter_post).toBe(true);
    const remote = jobs.find((j) => j.title === "Staff Software Engineer, Risk");
    expect(remote?.workplace_type).toBe("remote");
  });

  it("parses the small fixture", () => {
    const jobs = parseGreenhouseJobs({
      tenant: { slug: "tinyco" },
      company: "tinyco",
      response: readFixture("greenhouse.small.json"),
      observedAt: OBSERVED_AT,
    });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.workplace_type).toBe("remote");
  });

  it("parses the edge fixture: dedupes by id, handles entities/script/style", () => {
    const jobs = parseGreenhouseJobs({
      tenant: { slug: "edge" },
      company: "Edge",
      response: readFixture("greenhouse.edge.json"),
      observedAt: OBSERVED_AT,
    });
    expect(jobs).toHaveLength(2);
    const tagged = jobs.find((j) => j.title.includes("HTML entities"));
    expect(tagged?.description_excerpt).toBe("Real body");
    const ids = new Set(jobs.map((j) => j.id));
    expect(ids.size).toBe(jobs.length);
  });
});

describe("parseGreenhouseJobs (property)", () => {
  it("is deterministic on identical input", () => {
    const fixture = readFixture("greenhouse.large.json");
    fc.assert(
      fc.property(fc.constantFrom("example", "anothertenant"), (slug) => {
        const a = parseGreenhouseJobs({
          tenant: { slug },
          company: slug,
          response: fixture,
          observedAt: OBSERVED_AT,
        });
        const b = parseGreenhouseJobs({
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

describe("scrapeGreenhouseTenant", () => {
  it("hits the correct endpoint and returns success", async () => {
    server.use(
      http.get("https://boards-api.greenhouse.io/v1/boards/example/jobs", () =>
        HttpResponse.json(readFixture("greenhouse.small.json")),
      ),
    );
    const client = clientWithRobotsAllowAll();
    const out = await scrapeGreenhouseTenant({
      tenant: { slug: "example", display_name: "Example" },
      client,
      observedAt: OBSERVED_AT,
    });
    expect(out.result.status).toBe("success");
    expect(out.result.jobs_count).toBe(1);
    expect(out.jobs[0]?.company).toBe("Example");
  });

  it("retries on 5xx then succeeds", async () => {
    let attempts = 0;
    server.use(
      http.get("https://boards-api.greenhouse.io/v1/boards/flake/jobs", () => {
        attempts += 1;
        if (attempts < 2) return new HttpResponse("err", { status: 503 });
        return HttpResponse.json(readFixture("greenhouse.small.json"));
      }),
    );
    const client = clientWithRobotsAllowAll();
    const out = await scrapeGreenhouseTenant({
      tenant: { slug: "flake" },
      client,
      observedAt: OBSERVED_AT,
    });
    expect(attempts).toBe(2);
    expect(out.result.status).toBe("success");
  });

  it("marks tenant dead on 404", async () => {
    server.use(
      http.get(
        "https://boards-api.greenhouse.io/v1/boards/missing/jobs",
        () => new HttpResponse("nope", { status: 404 }),
      ),
    );
    const client = clientWithRobotsAllowAll();
    const out = await scrapeGreenhouseTenant({
      tenant: { slug: "missing" },
      client,
      observedAt: OBSERVED_AT,
    });
    expect(out.result.status).toBe("dead");
    expect(out.result.http_status).toBe(404);
  });

  it("marks tenant transient_failure on exhausted retries", async () => {
    server.use(
      http.get(
        "https://boards-api.greenhouse.io/v1/boards/down/jobs",
        () => new HttpResponse("err", { status: 502 }),
      ),
    );
    const client = clientWithRobotsAllowAll();
    const out = await scrapeGreenhouseTenant({
      tenant: { slug: "down" },
      client,
      observedAt: OBSERVED_AT,
    });
    expect(out.result.status).toBe("transient_failure");
  });

  it("blocks on robots.txt Disallow: /", async () => {
    const robotsFetch = mock(async (input: Request | string) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.endsWith("/robots.txt"))
        return new Response("User-agent: *\nDisallow: /\n", { status: 200 });
      throw new Error(`unexpected ${url}`);
    });
    const robots = new RobotsTxtCache({ fetchFn: robotsFetch, clock: () => 0 });
    const client = new HttpClient({
      userAgent: "openroles/0.0.0 (+https://example.com)",
      robots,
      sleep: async () => {},
      random: () => 0.5,
      retry: { maxAttempts: 1, baseMs: 1, maxMs: 1 },
    });
    const out = await scrapeGreenhouseTenant({
      tenant: { slug: "blocked" },
      client,
      observedAt: OBSERVED_AT,
    });
    expect(out.result.status).toBe("dead");
    expect(out.result.error).toContain("robots.txt");
  });

  it("marks tenant dead on JSON parse failure", async () => {
    server.use(
      http.get(
        "https://boards-api.greenhouse.io/v1/boards/garbled/jobs",
        () => new HttpResponse("not json", { status: 200 }),
      ),
    );
    const client = clientWithRobotsAllowAll();
    const out = await scrapeGreenhouseTenant({
      tenant: { slug: "garbled" },
      client,
      observedAt: OBSERVED_AT,
    });
    expect(out.result.status).toBe("dead");
  });

  it("encodes the slug in the URL path", async () => {
    let urlCalled: string | null = null;
    server.use(
      http.get("https://boards-api.greenhouse.io/v1/boards/:slug/jobs", ({ request }) => {
        urlCalled = request.url;
        return HttpResponse.json(readFixture("greenhouse.small.json"));
      }),
    );
    const client = clientWithRobotsAllowAll();
    await scrapeGreenhouseTenant({
      tenant: { slug: "ok-slug" },
      client,
      observedAt: OBSERVED_AT,
    });
    expect(urlCalled).toContain("/v1/boards/ok-slug/jobs");
  });
});
