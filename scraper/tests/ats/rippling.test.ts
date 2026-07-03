import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from "bun:test";
import type { TenantInput } from "@openroles/shared";
import fc from "fast-check";
import {
  parseRipplingJobs,
  type RipplingDetail,
  ripplingJobUrl,
  scrapeRipplingTenant,
} from "../../src/ats/rippling.ts";
import { HttpClient } from "../../src/http.ts";
import { RobotsTxtCache } from "../../src/robots.ts";
import {
  clientWithRobotsAllowAll,
  HttpResponse,
  http,
  makeServer,
  readFixture,
} from "../helpers.ts";

const OBSERVED_AT = "2026-07-03T00:00:00Z";
const BOARD = "https://api.rippling.com/platform/api/ats/v1/board";

const server = makeServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function detailsMap(name: string): Map<string, RipplingDetail> {
  return new Map(Object.entries(readFixture(name) as Record<string, RipplingDetail>));
}

function parseFixture(
  listName: string,
  opts: { slug?: string; company?: string; detailsName?: string } = {},
): ReturnType<typeof parseRipplingJobs> {
  return parseRipplingJobs({
    tenant: { slug: opts.slug ?? "acme-careers" },
    company: opts.company ?? "Acme Corp",
    response: readFixture(listName),
    observedAt: OBSERVED_AT,
    ...(opts.detailsName ? { details: detailsMap(opts.detailsName) } : {}),
  });
}

// Register MSW handlers that serve the list array on the board URL and each
// detail object on `…/jobs/{uuid}` from the given details fixture.
function serveBoard(slug: string, listName: string, detailsName?: string): void {
  server.use(
    http.get(`${BOARD}/${slug}/jobs`, () => HttpResponse.json(readFixture(listName))),
    http.get(`${BOARD}/${slug}/jobs/:uuid`, ({ params }) => {
      if (!detailsName) return HttpResponse.json({});
      const details = readFixture(detailsName) as Record<string, unknown>;
      const record = details[params["uuid"] as string];
      return record ? HttpResponse.json(record) : new HttpResponse("not found", { status: 404 });
    }),
  );
}

function run(tenant: TenantInput): ReturnType<typeof scrapeRipplingTenant> {
  return scrapeRipplingTenant({
    tenant,
    client: clientWithRobotsAllowAll(),
    observedAt: OBSERVED_AT,
    perTenantConcurrency: 4,
  });
}

describe("ripplingJobUrl", () => {
  it("keeps a well-formed https link on the board host", () => {
    const url = "https://ats.rippling.com/acme-careers/jobs/abc";
    expect(ripplingJobUrl("acme-careers", "abc", url)).toBe(url);
  });

  it("falls back to the composed URL for off-host, downgraded, credentialed or malformed links", () => {
    const composed = "https://ats.rippling.com/acme-careers/jobs/abc";
    expect(ripplingJobUrl("acme-careers", "abc", "https://evil.example.com/abc")).toBe(composed);
    expect(ripplingJobUrl("acme-careers", "abc", "http://ats.rippling.com/x")).toBe(composed);
    expect(ripplingJobUrl("acme-careers", "abc", "https://u:p@ats.rippling.com/x")).toBe(composed);
    expect(ripplingJobUrl("acme-careers", "abc", "not a url")).toBe(composed);
    expect(ripplingJobUrl("acme-careers", "abc", null)).toBe(composed);
  });
});

describe("parseRipplingJobs (fixture replay)", () => {
  it("merges list + detail into validated, deep-linked Jobs", () => {
    const jobs = parseFixture("rippling.large.json", {
      detailsName: "rippling.large.details.json",
    });
    expect(jobs).toHaveLength(4);
    const byTitle = (t: string) => jobs.find((j) => j.title === t);

    // Title entity decoding (list `&amp;` → `&`).
    expect(byTitle("Product Manager & Strategy Lead")).toBeDefined();
    // Recruiter classification.
    expect(byTitle("Technical Recruiter")?.is_recruiter_post).toBe(true);
    expect(byTitle("Senior Software Engineer")?.is_recruiter_post).toBe(false);
    // Workplace inference from remote location text.
    expect(byTitle("Technical Recruiter")?.workplace_type).toBe("remote");
    expect(byTitle("Senior Software Engineer")?.workplace_type).toBeNull();
    // Location: detail workLocations first entry; region parsed from "City, ST".
    expect(byTitle("Senior Software Engineer")?.location_text).toBe("San Francisco, CA");
    expect(byTitle("Senior Software Engineer")?.location_region).toBe("CA");
    // Company: detail companyName, falling back to tenant display name when null.
    expect(byTitle("Senior Software Engineer")?.company).toBe("Acme Robotics, Inc.");
    expect(byTitle("Sales Associate")?.company).toBe("Acme Corp");
    // Department: list department.label.
    expect(byTitle("Senior Software Engineer")?.department).toBe("Engineering");
    expect(byTitle("Sales Associate")?.department).toBeUndefined();
    // posted_at: createdOn normalised to UTC Z.
    expect(byTitle("Senior Software Engineer")?.posted_at).toBe("2026-06-01T16:00:00.000Z");
    // Description excerpt: HTML stripped from description.role.
    expect(byTitle("Senior Software Engineer")?.description_excerpt).toContain(
      "Build the platform",
    );
    expect(byTitle("Senior Software Engineer")?.description_excerpt).not.toContain("<p>");
    // Compensation from the first pay range.
    expect(byTitle("Senior Software Engineer")?.compensation_min).toBe(180000);
    expect(byTitle("Senior Software Engineer")?.compensation_max).toBe(220000);
    expect(byTitle("Senior Software Engineer")?.compensation_currency).toBe("USD");
    // Inverted range is dropped, keeping the row.
    expect(byTitle("Sales Associate")?.compensation_min).toBeUndefined();
    expect(byTitle("Sales Associate")?.compensation_max).toBeUndefined();
    // Empty detail workLocations falls back to the list workLocation.label.
    expect(byTitle("Sales Associate")?.location_text).toBe("Berlin, DE");
    // URL is the canonical board deep link.
    expect(byTitle("Senior Software Engineer")?.url).toBe(
      "https://ats.rippling.com/acme-careers/jobs/11111111-1111-4111-8111-111111111111",
    );
    expect(new Set(jobs.map((j) => j.id)).size).toBe(jobs.length);
  });

  it("parses the small fixture list-only when no detail is supplied", () => {
    const jobs = parseFixture("rippling.small.json");
    expect(jobs).toHaveLength(2);
    const ae = jobs.find((j) => j.title === "Account Executive - Municipalities");
    // List-only: location from workLocation.label, no posted_at/description.
    expect(ae?.location_text).toBe("Remote (United States)");
    expect(ae?.workplace_type).toBe("remote");
    expect(ae?.posted_at).toBeUndefined();
    expect(ae?.description_excerpt).toBeUndefined();
    expect(ae?.company).toBe("Acme Corp"); // fallback, no detail
    expect(ae?.source_id).toBe("4345711d-74af-400f-8872-8b1b5393dcdf");
  });

  it("enriches the small fixture from its detail records", () => {
    const jobs = parseFixture("rippling.small.json", { detailsName: "rippling.details.json" });
    const ae = jobs.find((j) => j.title === "Account Executive - Municipalities");
    expect(ae?.company).toBe("Acme, Inc.");
    expect(ae?.posted_at).toBe("2026-05-14T15:06:50.603Z");
    expect(ae?.description_excerpt).toContain("Mountain West");
    expect(ae?.compensation_min).toBe(200000);
    expect(ae?.compensation_max).toBe(250000);
    // Whitespace-only description.role → no excerpt.
    const tech = jobs.find((j) => j.title === "Field Service Technician");
    expect(tech?.description_excerpt).toBeUndefined();
  });

  it("handles the full array with no pagination (all rows in one call)", () => {
    // The large fixture is a top-level array; every row is emitted.
    const raw = readFixture("rippling.large.json") as unknown[];
    const jobs = parseFixture("rippling.large.json");
    expect(jobs).toHaveLength(raw.length);
  });

  it("skips malformed rows, host-guards the url, clamps future dates and dedupes", () => {
    const jobs = parseFixture("rippling.edge.json", {
      slug: "edgeco",
      company: "Edge Co",
      detailsName: "rippling.edge.details.json",
    });
    // Six rows in, three Jobs out: null-uuid + blank-name rows dropped, the
    // duplicate uuid deduped.
    expect(jobs).toHaveLength(3);
    expect(jobs.some((j) => j.title === "No UUID Role")).toBe(false);
    expect(jobs.filter((j) => j.source_id === "dddddddd-dddd-4ddd-8ddd-dddddddddddd")).toHaveLength(
      1,
    );
    // Off-host payload url falls back to the composed board URL.
    const offHost = jobs.find((j) => j.title === "Off-Host URL Role");
    expect(offHost?.url).toBe(
      "https://ats.rippling.com/edgeco/jobs/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    );
    // Future createdOn is dropped rather than failing validation.
    const future = jobs.find((j) => j.title === "Future Dated Role");
    expect(future).toBeDefined();
    expect(future?.posted_at).toBeUndefined();
  });

  it("returns no jobs when the response is not an array", () => {
    expect(
      parseRipplingJobs({
        tenant: { slug: "acme-careers" },
        company: "Acme",
        response: { error_code: "RESOURCE_NOT_FOUND" },
        observedAt: OBSERVED_AT,
      }),
    ).toHaveLength(0);
  });
});

describe("parseRipplingJobs (property)", () => {
  it("is deterministic on identical input", () => {
    const fixture = readFixture("rippling.large.json");
    const details = detailsMap("rippling.large.details.json");
    fc.assert(
      fc.property(fc.constantFrom("acme-careers", "globex", "initech"), (slug) => {
        const one = parseRipplingJobs({
          tenant: { slug },
          company: slug,
          response: fixture,
          observedAt: OBSERVED_AT,
          details,
        });
        const two = parseRipplingJobs({
          tenant: { slug },
          company: slug,
          response: fixture,
          observedAt: OBSERVED_AT,
          details,
        });
        return JSON.stringify(one) === JSON.stringify(two);
      }),
      { numRuns: 20 },
    );
  });
});

describe("scrapeRipplingTenant", () => {
  it("hits the list API, fans out detail GETs, and returns success", async () => {
    serveBoard("acme-careers", "rippling.small.json", "rippling.details.json");
    const out = await run({ slug: "acme-careers", display_name: "Acme Corp" });
    expect(out.result.status).toBe("success");
    expect(out.result.jobs_count).toBe(2);
    expect(out.result.http_status).toBe(200);
    const ae = out.jobs.find((j) => j.title === "Account Executive - Municipalities");
    expect(ae?.company).toBe("Acme, Inc.");
    expect(ae?.posted_at).toBe("2026-05-14T15:06:50.603Z");
    expect(out.result.error).toBeUndefined();
  });

  it("fans out one detail GET per role", async () => {
    const detailHits: string[] = [];
    server.use(
      http.get(`${BOARD}/countco/jobs`, () =>
        HttpResponse.json(readFixture("rippling.large.json")),
      ),
      http.get(`${BOARD}/countco/jobs/:uuid`, ({ params }) => {
        detailHits.push(params["uuid"] as string);
        return HttpResponse.json({});
      }),
    );
    const out = await run({ slug: "countco" });
    expect(out.result.jobs_count).toBe(4);
    expect(detailHits).toHaveLength(4);
  });

  it("caps the detail fan-out and reports a capped note", async () => {
    const list = Array.from({ length: 3 }, (_, i) => ({
      uuid: `1111111${i}-1111-4111-8111-111111111111`,
      name: `Role ${i}`,
      url: `https://ats.rippling.com/capco/jobs/1111111${i}-1111-4111-8111-111111111111`,
      workLocation: { label: "Remote (United States)" },
    }));
    let detailHits = 0;
    server.use(
      http.get(`${BOARD}/capco/jobs`, () => HttpResponse.json(list)),
      http.get(`${BOARD}/capco/jobs/:uuid`, () => {
        detailHits += 1;
        return HttpResponse.json({});
      }),
    );
    const out = await scrapeRipplingTenant({
      tenant: { slug: "capco" },
      client: clientWithRobotsAllowAll(),
      observedAt: OBSERVED_AT,
      perTenantConcurrency: 4,
      maxDetailFetch: 2,
    });
    // All three roles still emit a Job (list-only for the uncapped tail), but
    // only two detail GETs run and the result carries a capped note.
    expect(out.result.jobs_count).toBe(3);
    expect(detailHits).toBe(2);
    expect(out.result.error).toBe("capped at 2 of 3 roles");
  });

  it("keeps the list-only row when a detail GET fails", async () => {
    server.use(
      http.get(`${BOARD}/partialco/jobs`, () =>
        HttpResponse.json(readFixture("rippling.small.json")),
      ),
      http.get(`${BOARD}/partialco/jobs/:uuid`, () => new HttpResponse("boom", { status: 500 })),
    );
    const out = await run({ slug: "partialco" });
    // Both roles still emitted from list-only fields despite detail failures.
    expect(out.result.status).toBe("success");
    expect(out.result.jobs_count).toBe(2);
    const ae = out.jobs.find((j) => j.title === "Account Executive - Municipalities");
    expect(ae?.posted_at).toBeUndefined();
  });

  it("returns success with zero jobs for an empty board", async () => {
    server.use(http.get(`${BOARD}/emptyco/jobs`, () => HttpResponse.json([])));
    const out = await run({ slug: "emptyco" });
    expect(out.result.status).toBe("success");
    expect(out.result.jobs_count).toBe(0);
  });

  it("retries on 5xx then succeeds", async () => {
    let attempts = 0;
    server.use(
      http.get(`${BOARD}/flakeco/jobs`, () => {
        attempts += 1;
        if (attempts < 2) return new HttpResponse("err", { status: 503 });
        return HttpResponse.json(readFixture("rippling.small.json"));
      }),
      http.get(`${BOARD}/flakeco/jobs/:uuid`, () => HttpResponse.json({})),
    );
    const out = await run({ slug: "flakeco" });
    expect(attempts).toBe(2);
    expect(out.result.status).toBe("success");
  });

  it("honors Retry-After on 429 then succeeds", async () => {
    let attempts = 0;
    server.use(
      http.get(`${BOARD}/throttleco/jobs`, () => {
        attempts += 1;
        if (attempts < 2) {
          return new HttpResponse("slow down", { status: 429, headers: { "retry-after": "0" } });
        }
        return HttpResponse.json(readFixture("rippling.small.json"));
      }),
      http.get(`${BOARD}/throttleco/jobs/:uuid`, () => HttpResponse.json({})),
    );
    const out = await run({ slug: "throttleco" });
    expect(attempts).toBe(2);
    expect(out.result.status).toBe("success");
  });

  it("marks the tenant transient_failure on exhausted 5xx", async () => {
    server.use(http.get(`${BOARD}/downco/jobs`, () => new HttpResponse("err", { status: 502 })));
    const out = await run({ slug: "downco" });
    expect(out.result.status).toBe("transient_failure");
  });

  it("marks the tenant dead on 404 (unknown slug)", async () => {
    server.use(
      http.get(`${BOARD}/goneco/jobs`, () => new HttpResponse("not found", { status: 404 })),
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
    const out = await scrapeRipplingTenant({
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

  it("accepts hyphenated slugs (the dominant real-world shape)", async () => {
    serveBoard("routeware-careers", "rippling.small.json", "rippling.details.json");
    const out = await run({ slug: "routeware-careers" });
    expect(out.result.status).toBe("success");
    expect(out.result.jobs_count).toBe(2);
  });
});
