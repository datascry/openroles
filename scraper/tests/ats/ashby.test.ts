import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from "bun:test";
import fc from "fast-check";
import { parseAshbyJobs, scrapeAshbyTenant } from "../../src/ats/ashby.ts";
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

describe("parseAshbyJobs (fixture replay)", () => {
  it("parses the large fixture", () => {
    const jobs = parseAshbyJobs({
      tenant: { slug: "example" },
      company: "Example",
      response: readFixture("ashby.large.json"),
      observedAt: OBSERVED_AT,
    });
    expect(jobs).toHaveLength(3);
    const recruiter = jobs.find((j) => j.title === "Recruiter, Engineering");
    expect(recruiter?.is_recruiter_post).toBe(true);
    const remote = jobs.find((j) => j.source_id === "ashby-002");
    expect(remote?.workplace_type).toBe("remote");
  });

  it("parses the small fixture", () => {
    const jobs = parseAshbyJobs({
      tenant: { slug: "tinyco" },
      company: "tinyco",
      response: readFixture("ashby.small.json"),
      observedAt: OBSERVED_AT,
    });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.workplace_type).toBe("remote");
  });

  it("parses the edge fixture: dedupe + html sanitize", () => {
    const jobs = parseAshbyJobs({
      tenant: { slug: "edge" },
      company: "Edge",
      response: readFixture("ashby.edge.json"),
      observedAt: OBSERVED_AT,
    });
    expect(jobs.length).toBe(2);
    const html = jobs.find((j) => j.source_id === "html-only");
    expect(html?.description_excerpt).toBe("Real text.");
  });
});

describe("parseAshbyJobs (property)", () => {
  it("is deterministic on identical input", () => {
    const fixture = readFixture("ashby.large.json");
    fc.assert(
      fc.property(fc.constantFrom("a", "b"), (slug) => {
        const a = parseAshbyJobs({
          tenant: { slug },
          company: slug,
          response: fixture,
          observedAt: OBSERVED_AT,
        });
        const b = parseAshbyJobs({
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

describe("scrapeAshbyTenant", () => {
  it("hits the posting-api endpoint and returns success", async () => {
    server.use(
      http.get("https://api.ashbyhq.com/posting-api/job-board/example", () =>
        HttpResponse.json(readFixture("ashby.small.json")),
      ),
    );
    const client = clientWithRobotsAllowAll();
    const out = await scrapeAshbyTenant({
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
      http.get("https://api.ashbyhq.com/posting-api/job-board/flake", () => {
        attempts += 1;
        if (attempts < 2) return new HttpResponse("err", { status: 503 });
        return HttpResponse.json(readFixture("ashby.small.json"));
      }),
    );
    const client = clientWithRobotsAllowAll();
    const out = await scrapeAshbyTenant({
      tenant: { slug: "flake" },
      client,
      observedAt: OBSERVED_AT,
    });
    expect(out.result.status).toBe("success");
  });

  it("bypasses robots.txt — api.ashbyhq.com responds 401 to /robots.txt and the /posting-api endpoint is the documented public read-only feed", async () => {
    // The robots fetch should NEVER be called — the scraper passes
    // skipRobots: true. If it is called, we'd see this mock's deny-all
    // response and the request would fail.
    const robotsFetch = mock(
      async () => new Response("User-agent: *\nDisallow: /\n", { status: 200 }),
    );
    const robots = new RobotsTxtCache({ fetchFn: robotsFetch, clock: () => 0 });
    server.use(
      http.get("https://api.ashbyhq.com/posting-api/job-board/0g", () =>
        HttpResponse.json({ jobs: [] }),
      ),
    );
    const client = new HttpClient({
      userAgent: "openroles/0.0.0",
      robots,
      sleep: async () => {},
      random: () => 0.5,
      retry: { maxAttempts: 1, baseMs: 1, maxMs: 1 },
    });
    const out = await scrapeAshbyTenant({
      tenant: { slug: "0g" },
      client,
      observedAt: OBSERVED_AT,
    });
    expect(out.result.status).toBe("success");
    expect(robotsFetch).not.toHaveBeenCalled();
  });
});
