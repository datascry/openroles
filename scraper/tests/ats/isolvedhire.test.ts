import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from "bun:test";
import type { TenantInput } from "@openroles/shared";
import fc from "fast-check";
import {
  extractIsolvedhireDomainId,
  normalizeIsolvedhireDate,
  parseIsolvedhireJobs,
  scrapeIsolvedhireTenant,
} from "../../src/ats/isolvedhire.ts";
import { HttpClient } from "../../src/http.ts";
import { RobotsTxtCache } from "../../src/robots.ts";
import {
  clientWithRobotsAllowAll,
  HttpResponse,
  http,
  makeServer,
  readFixture,
  readFixtureText,
} from "../helpers.ts";

const OBSERVED_AT = "2026-07-03T00:00:00Z";
const SLUG = "acme";
const BOARD_URL = `https://${SLUG}.isolvedhire.com/jobs/`;
const API_URL = `https://${SLUG}.isolvedhire.com/core/jobs/9440`;
const BOARD = readFixtureText("isolvedhire.board.html");
const NOBOOT = readFixtureText("isolvedhire.noboot.html");
const SMALL = readFixture("isolvedhire.small.json");
const LARGE = readFixture("isolvedhire.large.json");
const EDGE = readFixture("isolvedhire.edge.json");
const FAILURE = readFixture("isolvedhire.failure.json");

const server = makeServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function parse(response: unknown, tenant: TenantInput = { slug: SLUG, display_name: "Acme Corp" }) {
  return parseIsolvedhireJobs({
    tenant,
    company: tenant.display_name ?? tenant.slug,
    response,
    observedAt: OBSERVED_AT,
  });
}

function run(tenant: TenantInput): ReturnType<typeof scrapeIsolvedhireTenant> {
  return scrapeIsolvedhireTenant({
    tenant,
    client: clientWithRobotsAllowAll(),
    observedAt: OBSERVED_AT,
  });
}

describe("extractIsolvedhireDomainId", () => {
  it("reads domain_id from the courierCurrentRouteData bootstrap blob", () => {
    expect(extractIsolvedhireDomainId(BOARD)).toBe("9440");
  });

  it("returns null when the bootstrap blob is absent", () => {
    expect(extractIsolvedhireDomainId(NOBOOT)).toBeNull();
    expect(extractIsolvedhireDomainId("")).toBeNull();
  });

  it("reads an unquoted numeric domain_id too", () => {
    const html = `mountingData.courierCurrentRouteData = {"domain_id":2851,"career_site_name":"X"};`;
    expect(extractIsolvedhireDomainId(html)).toBe("2851");
  });
});

describe("normalizeIsolvedhireDate", () => {
  it("converts the vendor 'MMM DD, YYYY' shape to UTC-midnight ISO", () => {
    expect(normalizeIsolvedhireDate("Apr 17, 2026")).toBe("2026-04-17T00:00:00Z");
    expect(normalizeIsolvedhireDate("Jun 5, 2026")).toBe("2026-06-05T00:00:00Z");
  });

  it("returns undefined for unparseable or missing input", () => {
    expect(normalizeIsolvedhireDate("Soon")).toBeUndefined();
    expect(normalizeIsolvedhireDate("Foo 17, 2026")).toBeUndefined();
    expect(normalizeIsolvedhireDate("")).toBeUndefined();
  });
});

describe("parseIsolvedhireJobs (fixture replay)", () => {
  it("parses the small board into validated Jobs", () => {
    const jobs = parse(SMALL);
    expect(jobs).toHaveLength(2);
    const driver = jobs.find((j) => j.source_id === "1788740");
    expect(driver?.title).toBe("Fleet Fuel Day or Evening Driver NO WEEKENDS");
    expect(driver?.company).toBe("Acme Corp");
    expect(driver?.url).toBe("https://davidsonoil.isolvedhire.com/jobs/1788740");
    expect(driver?.location_text).toBe("Amarillo, TX");
    expect(driver?.location_region).toBe("TX");
    expect(driver?.location_country).toBe("US");
    expect(driver?.posted_at).toBe("2026-06-05T00:00:00Z");
    expect(driver?.workplace_type).toBe("onsite");
    expect(driver?.department).toBe("Operations");
    expect(driver?.compensation_min).toBe(20);
    expect(driver?.compensation_max).toBe(23);

    const payroll = jobs.find((j) => j.source_id === "1791513");
    expect(payroll?.posted_at).toBe("2026-06-10T00:00:00Z");
    expect(payroll?.compensation_min).toBeUndefined();
    expect(payroll?.compensation_max).toBeUndefined();
  });

  it("parses the large board, including comma-grouped annual salaries", () => {
    const jobs = parse(LARGE);
    expect(jobs).toHaveLength(5);
    const cdl = jobs.find((j) => j.source_id === "1797979");
    expect(cdl?.compensation_min).toBe(75_000);
    expect(cdl?.compensation_max).toBe(90_000);
    expect(cdl?.posted_at).toBe("2026-06-18T00:00:00Z");
    const hourly = jobs.find((j) => j.source_id === "1752532");
    expect(hourly?.compensation_min).toBe(23); // "22.5" rounds to the nearest whole unit
    expect(hourly?.compensation_max).toBe(35);
    expect(new Set(jobs.map((j) => j.id)).size).toBe(jobs.length);
  });

  it("never publishes a credentialed or malformed jobUrl", () => {
    const jobs = parse({
      success: true,
      data: {
        jobs: [
          // userinfo would survive the hostname check (URL.hostname strips
          // `user:pass@`) and leak verbatim into Job.url — must fall back.
          {
            id: 9101,
            title: "Dispatcher",
            jobUrl: "https://user:pass@acme.isolvedhire.com/jobs/9101",
          },
          // https:// prefix but unparseable → new URL throws → fall back.
          { id: 9102, title: "Loader", jobUrl: "https://[bad" },
        ],
      },
    });
    expect(jobs.map((j) => j.url)).toEqual([
      `https://${SLUG}.isolvedhire.com/jobs/9101`,
      `https://${SLUG}.isolvedhire.com/jobs/9102`,
    ]);
  });

  it("handles the edge board: nulls, dupes, entities, bad dates, bad pay", () => {
    const jobs = parse(EDGE);
    // 7 rows: one lacks an id, one lacks a title, one id repeats → 4 jobs.
    expect(jobs).toHaveLength(4);

    const welder = jobs.find((j) => j.source_id === "9001");
    expect(welder?.title).toBe("Maintenance Tech & Welder"); // entities decoded
    expect(welder?.location_text).toBeUndefined(); // null city + null jobLocation
    expect(welder?.workplace_type).toBe("remote");
    expect(welder?.posted_at).toBeUndefined(); // null startDateRef
    // min "30" > max "20" → the inconsistent pair is dropped, not the row.
    expect(welder?.compensation_min).toBeUndefined();
    expect(welder?.compensation_max).toBeUndefined();
    // No jobUrl in the record → canonical public URL is composed from the slug.
    expect(welder?.url).toBe(`https://${SLUG}.isolvedhire.com/jobs/9001`);

    const associate = jobs.filter((j) => j.source_id === "9002");
    expect(associate).toHaveLength(1); // duplicate id deduped
    expect(associate[0]?.posted_at).toBe("2026-05-01T00:00:00Z");
    expect(associate[0]?.department).toBe("Retail");

    const recruiter = jobs.find((j) => j.source_id === "9003");
    expect(recruiter?.posted_at).toBeUndefined(); // future startDateRef dropped
    // Off-platform jobUrl is not trusted; the composed board URL wins.
    expect(recruiter?.url).toBe(`https://${SLUG}.isolvedhire.com/jobs/9003`);
    expect(recruiter?.workplace_type).toBe("hybrid");
    expect(recruiter?.location_country).toBe("CA");
    expect(recruiter?.location_region).toBe("ON");
    expect(recruiter?.department).toBe("Human Resources");
    expect(recruiter?.is_recruiter_post).toBe(true);

    const manager = jobs.find((j) => j.source_id === "9004");
    expect(manager?.posted_at).toBeUndefined(); // "Soon" is unparseable
    expect(manager?.compensation_min).toBe(18); // "17.5" rounds up
    expect(manager?.compensation_max).toBeUndefined();
    expect(manager?.workplace_type).toBe("onsite"); // "On-Site" variant
    expect(manager?.location_text).toBe("Reno, NV");
    expect(manager?.location_country).toBeUndefined(); // unknown iso3
  });

  it("throws a transient error on success:false", () => {
    expect(() => parse(FAILURE)).toThrow("job list unavailable");
  });

  it("throws a transient error when data.jobs is missing", () => {
    expect(() => parse({ success: true, data: {} })).toThrow("job list unavailable");
    expect(() => parse({ success: true })).toThrow("job list unavailable");
  });
});

describe("parseIsolvedhireJobs (property)", () => {
  it("is deterministic on identical input", () => {
    fc.assert(
      fc.property(fc.constantFrom("acme", "globex", "initech"), (slug) => {
        const a = parse(EDGE, { slug });
        const b = parse(EDGE, { slug });
        return JSON.stringify(a) === JSON.stringify(b);
      }),
      { numRuns: 15 },
    );
  });
});

describe("scrapeIsolvedhireTenant", () => {
  it("bootstraps the domain_id from the board page, then fetches the job list", async () => {
    server.use(
      http.get(BOARD_URL, () => new HttpResponse(BOARD)),
      http.get(API_URL, () => HttpResponse.json(SMALL)),
    );
    const out = await run({ slug: SLUG, display_name: "Acme Corp" });
    expect(out.result.status).toBe("success");
    expect(out.result.jobs_count).toBe(2);
    expect(out.result.http_status).toBe(200);
    expect(out.jobs.every((j) => j.ats === "isolvedhire")).toBe(true);
  });

  it("marks the tenant dead when the board page has no domain_id", async () => {
    server.use(http.get(BOARD_URL, () => new HttpResponse(NOBOOT)));
    const out = await run({ slug: SLUG });
    expect(out.result.status).toBe("dead");
    expect(out.result.error).toContain("domain_id");
    expect(out.result.jobs_count).toBe(0);
  });

  it("marks the tenant transient when the API answers success:false", async () => {
    server.use(
      http.get(BOARD_URL, () => new HttpResponse(BOARD)),
      http.get(API_URL, () => HttpResponse.json(FAILURE)),
    );
    const out = await run({ slug: SLUG });
    expect(out.result.status).toBe("transient_failure");
    expect(out.result.error).toContain("job list unavailable");
  });

  it("retries a 5xx on the bootstrap step then succeeds", async () => {
    let n = 0;
    server.use(
      http.get(BOARD_URL, () => {
        n += 1;
        return n < 2 ? new HttpResponse("err", { status: 503 }) : new HttpResponse(BOARD);
      }),
      http.get(API_URL, () => HttpResponse.json(SMALL)),
    );
    const out = await run({ slug: SLUG });
    expect(n).toBe(2);
    expect(out.result.status).toBe("success");
  });

  it("retries a 5xx on the job-list step then succeeds", async () => {
    let n = 0;
    server.use(
      http.get(BOARD_URL, () => new HttpResponse(BOARD)),
      http.get(API_URL, () => {
        n += 1;
        return n < 2 ? new HttpResponse("err", { status: 503 }) : HttpResponse.json(SMALL);
      }),
    );
    const out = await run({ slug: SLUG });
    expect(n).toBe(2);
    expect(out.result.status).toBe("success");
    expect(out.result.jobs_count).toBe(2);
  });

  it("marks dead on 404 and transient on exhausted 5xx", async () => {
    server.use(http.get(BOARD_URL, () => new HttpResponse("no", { status: 404 })));
    expect((await run({ slug: SLUG })).result.status).toBe("dead");
    server.resetHandlers();
    server.use(http.get(BOARD_URL, () => new HttpResponse("err", { status: 502 })));
    expect((await run({ slug: SLUG })).result.status).toBe("transient_failure");
  });

  it("blocks on robots.txt Disallow: /", async () => {
    const robotsFetch = mock(async (input: Request | string) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.endsWith("/robots.txt"))
        return new Response("User-agent: *\nDisallow: /\n", { status: 200 });
      throw new Error(`unexpected ${url}`);
    });
    const client = new HttpClient({
      userAgent: "openroles/0.0.0 (+https://example.com)",
      robots: new RobotsTxtCache({ fetchFn: robotsFetch, clock: () => 0 }),
      sleep: async () => {},
      random: () => 0.5,
      retry: { maxAttempts: 1, baseMs: 1, maxMs: 1 },
    });
    const out = await scrapeIsolvedhireTenant({
      tenant: { slug: SLUG },
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
});
