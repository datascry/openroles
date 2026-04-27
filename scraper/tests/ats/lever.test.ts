import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from "bun:test";
import fc from "fast-check";
import { parseLeverPostings, scrapeLeverTenant } from "../../src/ats/lever.ts";
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

describe("parseLeverPostings (fixture replay)", () => {
  it("parses the large fixture", () => {
    const jobs = parseLeverPostings({
      tenant: { slug: "example", display_name: "Example" },
      company: "Example",
      response: readFixture("lever.large.json"),
      observedAt: OBSERVED_AT,
    });
    expect(jobs).toHaveLength(3);
    const sourcer = jobs.find((j) => j.title === "Sourcer, GTM");
    expect(sourcer?.is_recruiter_post).toBe(true);
    expect(sourcer?.workplace_type).toBe("onsite");
  });

  it("parses the small fixture", () => {
    const jobs = parseLeverPostings({
      tenant: { slug: "tinyco" },
      company: "tinyco",
      response: readFixture("lever.small.json"),
      observedAt: OBSERVED_AT,
    });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.workplace_type).toBe("remote");
    expect(jobs[0]?.posted_at).toBe("2024-02-27T02:13:20.000Z");
  });

  it("parses the edge fixture: missing fields, html-only description", () => {
    const jobs = parseLeverPostings({
      tenant: { slug: "edge" },
      company: "Edge",
      response: readFixture("lever.edge.json"),
      observedAt: OBSERVED_AT,
    });
    expect(jobs).toHaveLength(2);
    const html = jobs.find((j) => j.source_id === "no-categories");
    expect(html?.description_excerpt).toBe("HTML body only.");
    const ids = new Set(jobs.map((j) => j.id));
    expect(ids.size).toBe(jobs.length);
  });
});

describe("parseLeverPostings (property)", () => {
  it("is deterministic on identical input", () => {
    const fixture = readFixture("lever.large.json");
    fc.assert(
      fc.property(fc.constantFrom("example", "another"), (slug) => {
        const a = parseLeverPostings({
          tenant: { slug },
          company: slug,
          response: fixture,
          observedAt: OBSERVED_AT,
        });
        const b = parseLeverPostings({
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

describe("scrapeLeverTenant", () => {
  it("hits the postings endpoint and returns success", async () => {
    server.use(
      http.get("https://api.lever.co/v0/postings/example", () =>
        HttpResponse.json(readFixture("lever.small.json")),
      ),
    );
    const client = clientWithRobotsAllowAll();
    const out = await scrapeLeverTenant({
      tenant: { slug: "example" },
      client,
      observedAt: OBSERVED_AT,
    });
    expect(out.result.status).toBe("success");
    expect(out.result.jobs_count).toBe(1);
  });

  it("retries on 5xx then succeeds", async () => {
    let attempts = 0;
    server.use(
      http.get("https://api.lever.co/v0/postings/flake", () => {
        attempts += 1;
        if (attempts < 2) return new HttpResponse("err", { status: 503 });
        return HttpResponse.json(readFixture("lever.small.json"));
      }),
    );
    const client = clientWithRobotsAllowAll();
    const out = await scrapeLeverTenant({
      tenant: { slug: "flake" },
      client,
      observedAt: OBSERVED_AT,
    });
    expect(attempts).toBe(2);
    expect(out.result.status).toBe("success");
  });

  it("marks tenant dead on robots.txt Disallow: /", async () => {
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
    const out = await scrapeLeverTenant({
      tenant: { slug: "blocked" },
      client,
      observedAt: OBSERVED_AT,
    });
    expect(out.result.status).toBe("dead");
  });
});
