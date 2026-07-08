import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from "bun:test";
import type { TenantInput } from "@openroles/shared";
import fc from "fast-check";
import { parseJobscoreFeed, scrapeJobscoreTenant } from "../../src/ats/jobscore.ts";
import { HttpClient } from "../../src/http.ts";
import { RobotsTxtCache } from "../../src/robots.ts";
import {
  clientWithRobotsAllowAll,
  HttpResponse,
  http,
  makeServer,
  readFixture,
} from "../helpers.ts";

const OBSERVED_AT = "2026-06-01T00:00:00Z";
const FEED = "https://careers.jobscore.com/jobs";

const server = makeServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function parseFixture(
  name: string,
  opts: { slug?: string; company?: string } = {},
): ReturnType<typeof parseJobscoreFeed> {
  return parseJobscoreFeed({
    tenant: { slug: opts.slug ?? "acme" },
    company: opts.company ?? "Acme Corp",
    response: readFixture(name),
    observedAt: OBSERVED_AT,
  });
}

function run(tenant: TenantInput): ReturnType<typeof scrapeJobscoreTenant> {
  return scrapeJobscoreTenant({
    tenant,
    client: clientWithRobotsAllowAll(),
    observedAt: OBSERVED_AT,
  });
}

describe("parseJobscoreFeed (fixture replay)", () => {
  it("parses the large fixture into validated, deep-linked Jobs", () => {
    const jobs = parseFixture("jobscore.large.json", { slug: "gooddayfarm" });
    expect(jobs).toHaveLength(6);
    expect(jobs.map((j) => j.title)).toEqual([
      "Senior Software Engineer",
      "Technical Recruiter",
      "Cultivation Technician",
      "Marketing Manager",
      "Retail Associate",
      "Data Analyst",
    ]);
    const byTitle = (t: string) => jobs.find((j) => j.title === t);
    // Workplace inferred from title + location text.
    expect(byTitle("Senior Software Engineer")?.workplace_type).toBe("remote");
    expect(byTitle("Marketing Manager")?.workplace_type).toBe("hybrid");
    expect(byTitle("Retail Associate")?.workplace_type).toBeNull();
    // Recruiter classification.
    expect(byTitle("Technical Recruiter")?.is_recruiter_post).toBe(true);
    expect(byTitle("Retail Associate")?.is_recruiter_post).toBe(false);
    // Location → "City, ST" with a 2-letter region.
    expect(byTitle("Technical Recruiter")?.location_text).toBe("New Orleans, LA");
    expect(byTitle("Technical Recruiter")?.location_region).toBe("LA");
    // Company from the row's company_name.
    expect(byTitle("Data Analyst")?.company).toBe("Good Day Farm");
    // Canonical detail_url is kept verbatim when https on the shared host.
    expect(byTitle("Data Analyst")?.url).toBe(
      "https://careers.jobscore.com/careers/gooddayfarm/jobs/data-analyst-d1Jh2yFrbaHOXkxyUH5V6C",
    );
    expect(new Set(jobs.map((j) => j.id)).size).toBe(jobs.length);
  });

  it("parses the small fixture with excerpt, dates, location and department", () => {
    const jobs = parseFixture("jobscore.small.json", { slug: "solutions2go" });
    expect(jobs).toHaveLength(2);
    const mgr = jobs.find((j) => j.title === "Regional Product & Demand Planning Manager");
    // Title HTML entity is decoded.
    expect(mgr).toBeDefined();
    expect(mgr?.company).toBe("Solutions 2 GO");
    expect(mgr?.source_id).toBe("d02lIpZW9pVBUlBdjtK6_f");
    // Description HTML → plain-text excerpt, tags stripped.
    expect(mgr?.description_excerpt).toContain("Regional Product & Demand Planning Manager");
    expect(mgr?.description_excerpt).not.toContain("<p>");
    expect(mgr?.department).toBe("Compras");
    // opened_date → posted_at, last_updated_date → updated_at.
    expect(mgr?.posted_at).toBe("2026-05-27T16:22:10.459Z");
    expect(mgr?.updated_at).toBe("2026-05-27T16:24:50.102Z");
    // Canonical on-host detail_url is kept verbatim (tracking query intact).
    expect(mgr?.url).toBe(
      "https://careers.jobscore.com/careers/solutions2go/jobs/regional-product-demand-planning-manager-d02lIpZW9pVBUlBdjtK6_f?ref=rss&sid=68",
    );

    const warehouse = jobs.find((j) => j.title === "Warehouse Associate");
    expect(warehouse?.location_text).toBe("Toronto, ON");
    expect(warehouse?.location_region).toBe("ON");
    expect(warehouse?.posted_at).toBe("2026-03-10T09:00:00.000Z");
  });

  it("filters closed rows, dedupes, host-guards URLs and clamps dates", () => {
    const jobs = parseFixture("jobscore.edge.json", { slug: "edgeco", company: "Edge Co" });
    // Eleven rows in, seven Jobs out: closed status, null-id and blank-title
    // rows are dropped, and the duplicate id is deduped.
    expect(jobs).toHaveLength(7);
    expect(jobs.some((j) => j.title === "Filled Position")).toBe(false);
    expect(jobs.some((j) => j.title === "No Id Job")).toBe(false);
    expect(jobs.filter((j) => j.source_id === "dup1")).toHaveLength(1);

    // A valid on-host detail_url is kept verbatim.
    const dup = jobs.find((j) => j.source_id === "dup1");
    expect(dup?.url).toBe(
      "https://careers.jobscore.com/careers/edgeco/jobs/duplicate-role-dup1?ref=rss",
    );
    expect(dup?.posted_at).toBe("2026-04-01T00:00:00.000Z");

    // Off-host detail_url → composed deep link using url_slug.
    expect(jobs.find((j) => j.title === "Off Host Role")?.url).toBe(
      "https://careers.jobscore.com/careers/edgeco/jobs/off-host-role-e6",
    );
    // Userinfo in the URL → composed deep link using the bare id (no url_slug).
    expect(jobs.find((j) => j.title === "Userinfo Url Role")?.url).toBe(
      "https://careers.jobscore.com/careers/edgeco/jobs/e8",
    );
    // Malformed URL → composed deep link using the bare id.
    expect(jobs.find((j) => j.title === "Malformed Url Role")?.url).toBe(
      "https://careers.jobscore.com/careers/edgeco/jobs/e10",
    );
    // Http scheme downgrade on the matching host → composed (url_slug present).
    expect(jobs.find((j) => j.title === "Http Downgrade Role")?.url).toBe(
      "https://careers.jobscore.com/careers/edgeco/jobs/http-downgrade-role-e11",
    );

    // Future opened_date dropped; unparseable last_updated_date dropped;
    // whitespace-only description yields no excerpt.
    const future = jobs.find((j) => j.title === "Future Role");
    expect(future?.posted_at).toBeUndefined();
    expect(future?.updated_at).toBeUndefined();
    expect(future?.description_excerpt).toBeUndefined();

    // HTML entity in the title is decoded.
    expect(jobs.some((j) => j.title === "Front Desk & Guest Services")).toBe(true);
    // Company falls back to the feed-level company_name.
    expect(jobs.every((j) => j.company === "Edge Co")).toBe(true);
  });

  it("returns no jobs when the response has no jobs array", () => {
    expect(
      parseJobscoreFeed({
        tenant: { slug: "acme" },
        company: "Acme",
        response: {},
        observedAt: OBSERVED_AT,
      }),
    ).toHaveLength(0);
  });
});

describe("parseJobscoreFeed (property)", () => {
  it("is deterministic on identical input", () => {
    const fixture = readFixture("jobscore.large.json");
    fc.assert(
      fc.property(fc.constantFrom("acme", "globex", "initech"), (slug) => {
        const a = parseJobscoreFeed({
          tenant: { slug },
          company: slug,
          response: fixture,
          observedAt: OBSERVED_AT,
        });
        const b = parseJobscoreFeed({
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

describe("scrapeJobscoreTenant", () => {
  it("hits the public feed and returns success", async () => {
    server.use(
      http.get(`${FEED}/solutions2go/feed.json`, () =>
        HttpResponse.json(readFixture("jobscore.small.json")),
      ),
    );
    const out = await run({ slug: "solutions2go", display_name: "Solutions 2 GO" });
    expect(out.result.status).toBe("success");
    expect(out.result.jobs_count).toBe(2);
    expect(out.result.http_status).toBe(200);
    expect(out.jobs[0]?.company).toBe("Solutions 2 GO");
  });

  it("returns success with zero jobs for a board with no jobs array", async () => {
    server.use(http.get(`${FEED}/emptyco/feed.json`, () => HttpResponse.json({})));
    const out = await run({ slug: "emptyco" });
    expect(out.result.status).toBe("success");
    expect(out.result.jobs_count).toBe(0);
  });

  it("retries on 5xx then succeeds", async () => {
    let attempts = 0;
    server.use(
      http.get(`${FEED}/flakeco/feed.json`, () => {
        attempts += 1;
        if (attempts < 2) return new HttpResponse("err", { status: 503 });
        return HttpResponse.json(readFixture("jobscore.small.json"));
      }),
    );
    const out = await run({ slug: "flakeco" });
    expect(attempts).toBe(2);
    expect(out.result.status).toBe("success");
  });

  it("honors Retry-After on 429 then succeeds", async () => {
    let attempts = 0;
    server.use(
      http.get(`${FEED}/throttleco/feed.json`, () => {
        attempts += 1;
        if (attempts < 2) {
          return new HttpResponse("slow down", { status: 429, headers: { "retry-after": "0" } });
        }
        return HttpResponse.json(readFixture("jobscore.small.json"));
      }),
    );
    const out = await run({ slug: "throttleco" });
    expect(attempts).toBe(2);
    expect(out.result.status).toBe("success");
  });

  it("marks the tenant transient_failure on exhausted retries", async () => {
    server.use(
      http.get(`${FEED}/downco/feed.json`, () => new HttpResponse("err", { status: 502 })),
    );
    const out = await run({ slug: "downco" });
    expect(out.result.status).toBe("transient_failure");
  });

  it("marks the tenant dead on 404 (unknown slug)", async () => {
    server.use(
      http.get(`${FEED}/goneco/feed.json`, () => new HttpResponse("not found", { status: 404 })),
    );
    const out = await run({ slug: "goneco" });
    expect(out.result.status).toBe("dead");
    expect(out.result.http_status).toBe(404);
    expect(out.jobs).toHaveLength(0);
  });

  it("blocks on robots.txt Disallow: /", async () => {
    const robotsFetch = mock(async (input: Request | string) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.endsWith("/robots.txt")) {
        return new Response("User-agent: *\nDisallow: /\n", { status: 200 });
      }
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
    const out = await scrapeJobscoreTenant({
      tenant: { slug: "blocked" },
      client,
      observedAt: OBSERVED_AT,
    });
    expect(out.result.status).toBe("dead");
    expect(out.result.error).toContain("robots.txt");
  });

  it("marks the tenant dead on an unsafe slug", async () => {
    const out = await run({ slug: "Bad_Slug" });
    expect(out.result.status).toBe("dead");
    expect(out.result.error).toContain("tenant slug rejected");
  });

  it("accepts hyphenated slugs (a common real-world shape)", async () => {
    server.use(
      http.get(`${FEED}/good-day-farm/feed.json`, () =>
        HttpResponse.json(readFixture("jobscore.small.json")),
      ),
    );
    const out = await run({ slug: "good-day-farm" });
    expect(out.result.status).toBe("success");
    expect(out.result.jobs_count).toBe(2);
  });
});
