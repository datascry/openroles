import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from "bun:test";
import type { TenantInput } from "@openroles/shared";
import fc from "fast-check";
import { parseHireologyJobs, scrapeHireologyTenant } from "../../src/ats/hireology.ts";
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
const API = "https://api.hireology.com/v2/public/careers";

const server = makeServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function parseFixture(
  name: string,
  opts: { slug?: string; company?: string } = {},
): ReturnType<typeof parseHireologyJobs> {
  return parseHireologyJobs({
    tenant: { slug: opts.slug ?? "acme" },
    company: opts.company ?? "Acme Corp",
    response: readFixture(name),
    observedAt: OBSERVED_AT,
  });
}

function run(tenant: TenantInput): ReturnType<typeof scrapeHireologyTenant> {
  return scrapeHireologyTenant({
    tenant,
    client: clientWithRobotsAllowAll(),
    observedAt: OBSERVED_AT,
  });
}

describe("parseHireologyJobs (fixture replay)", () => {
  it("parses the large fixture into validated, deep-linked Jobs", () => {
    const jobs = parseFixture("hireology.large.json");
    expect(jobs).toHaveLength(6);
    expect(jobs.map((j) => j.title)).toEqual([
      "Senior Automotive Technician",
      "Customer Success Specialist",
      "Technical Recruiter",
      "Service Advisor",
      "Sales Consultant",
      "Body Shop Estimator",
    ]);
    const byTitle = (t: string) => jobs.find((j) => j.title === t);
    // `remote: true` is the authoritative workplace signal; without it the
    // title/location fallback applies (and yields null for onsite roles —
    // the payload has no onsite marker).
    expect(byTitle("Customer Success Specialist")?.workplace_type).toBe("remote");
    expect(byTitle("Senior Automotive Technician")?.workplace_type).toBeNull();
    // Recruiter classification.
    expect(byTitle("Technical Recruiter")?.is_recruiter_post).toBe(true);
    expect(byTitle("Senior Automotive Technician")?.is_recruiter_post).toBe(false);
    // Location: first entry of locations[], "City, ST".
    expect(byTitle("Senior Automotive Technician")?.location_text).toBe("Rapid City, SD");
    expect(byTitle("Senior Automotive Technician")?.location_region).toBe("SD");
    // Multi-location job keeps the first location only (deterministic).
    expect(byTitle("Service Advisor")?.location_text).toBe("Spearfish, SD");
    // Empty locations → no location_text.
    expect(byTitle("Customer Success Specialist")?.location_text).toBeUndefined();
    // URL: payload career_site_url when well-formed on the canonical host…
    expect(byTitle("Senior Automotive Technician")?.url).toBe(
      "https://careers.hireology.com/acme/300001/description",
    );
    // …constructed when null…
    expect(byTitle("Customer Success Specialist")?.url).toBe(
      "https://careers.hireology.com/acme/300002/description",
    );
    // …and constructed when the payload URL points off-host.
    expect(byTitle("Technical Recruiter")?.url).toBe(
      "https://careers.hireology.com/acme/300003/description",
    );
    // Company: organization.name, falling back to the tenant display name.
    expect(byTitle("Senior Automotive Technician")?.company).toBe("Acme Motors");
    expect(byTitle("Sales Consultant")?.company).toBe("Acme Corp");
    // Department from job_family.name; absent when job_family is null.
    expect(byTitle("Sales Consultant")?.department).toBe("Sales");
    expect(byTitle("Body Shop Estimator")?.department).toBeUndefined();
    expect(new Set(jobs.map((j) => j.id)).size).toBe(jobs.length);
  });

  it("parses the small fixture with excerpt, location and posted_at", () => {
    const jobs = parseFixture("hireology.small.json");
    expect(jobs).toHaveLength(2);
    const caregiver = jobs.find((j) => j.title === "Caregiver");
    expect(caregiver?.company).toBe("Acme Home Care");
    expect(caregiver?.source_id).toBe("2561400");
    expect(caregiver?.description_excerpt).toContain("non-medical support & companionship");
    expect(caregiver?.description_excerpt).toContain("Meal preparation");
    expect(caregiver?.description_excerpt).not.toContain("<p>");
    expect(caregiver?.location_text).toBe("Evansville, IN");
    expect(caregiver?.location_region).toBe("IN");
    expect(caregiver?.department).toBe("General");
    expect(caregiver?.posted_at).toBe("2025-10-22T15:01:42.316Z");
    expect(caregiver?.url).toBe("https://careers.hireology.com/acme/2561400/description");
    expect(jobs.find((j) => j.title === "General Manager")?.posted_at).toBe(
      "2026-05-08T18:26:00.865Z",
    );
  });

  it("skips malformed and non-open rows and normalises edge cases", () => {
    const jobs = parseFixture("hireology.edge.json", { slug: "edgeco", company: "Edge Co" });
    // Eight rows in, four Jobs out: null-id and blank-name rows are
    // malformed, the Closed row is filtered, and the duplicate id is deduped.
    expect(jobs).toHaveLength(4);
    expect(jobs.some((j) => j.title === "No Id Job")).toBe(false);
    expect(jobs.some((j) => j.title === "Housekeeper")).toBe(false);
    expect(jobs.filter((j) => j.source_id === "400002")).toHaveLength(1);

    const remote = jobs.find((j) => j.title === "Remote Scheduling Coordinator");
    expect(remote?.workplace_type).toBe("remote"); // remote:true wins
    expect(remote?.location_text).toBeUndefined(); // empty locations[]
    expect(remote?.description_excerpt).toBeUndefined(); // whitespace-only HTML

    const frontDesk = jobs.find((j) => j.source_id === "400002");
    expect(frontDesk?.title).toBe("Front Desk & Guest Services"); // entities decoded
    expect(frontDesk?.location_text).toBe("Deadwood"); // city only, no state
    expect(frontDesk?.location_region).toBeUndefined();
    expect(frontDesk?.department).toBe("Hospitality"); // trimmed
    // Malformed career_site_url falls back to the constructed deep link.
    expect(frontDesk?.url).toBe("https://careers.hireology.com/edgeco/400002/description");

    const auditor = jobs.find((j) => j.title === "Night Auditor");
    expect(auditor?.posted_at).toBeUndefined(); // future created_at dropped
    expect(auditor?.location_text).toBe("SD"); // state only, no city
    expect(auditor?.company).toBe("Edge Co"); // organization null → fallback

    const maintenance = jobs.find((j) => j.title === "Maintenance Technician");
    expect(maintenance?.posted_at).toBeUndefined(); // null created_at
    expect(maintenance?.location_text).toBeUndefined(); // locations null
    expect(maintenance?.workplace_type).toBeNull(); // remote null, no hint
  });

  it("returns no jobs when the response has no data array", () => {
    expect(
      parseHireologyJobs({
        tenant: { slug: "acme" },
        company: "Acme",
        response: {},
        observedAt: OBSERVED_AT,
      }),
    ).toHaveLength(0);
  });
});

describe("parseHireologyJobs (property)", () => {
  it("is deterministic on identical input", () => {
    const fixture = readFixture("hireology.large.json");
    fc.assert(
      fc.property(fc.constantFrom("acme", "globex", "initech"), (slug) => {
        const a = parseHireologyJobs({
          tenant: { slug },
          company: slug,
          response: fixture,
          observedAt: OBSERVED_AT,
        });
        const b = parseHireologyJobs({
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

describe("scrapeHireologyTenant", () => {
  it("hits the public careers endpoint and returns success", async () => {
    server.use(
      http.get(`${API}/acme`, () => HttpResponse.json(readFixture("hireology.small.json"))),
    );
    const out = await run({ slug: "acme", display_name: "Acme Corp" });
    expect(out.result.status).toBe("success");
    expect(out.result.jobs_count).toBe(2);
    expect(out.result.http_status).toBe(200);
    expect(out.jobs[0]?.company).toBe("Acme Home Care");
  });

  it("paginates page/page_size until count is reached", async () => {
    const total = 150;
    const all = Array.from({ length: total }, (_, i) => ({
      id: 500000 + i,
      name: `Role ${i}`,
      created_at: "2026-05-01T00:00:00.000Z",
      status: "Open",
      locations: [{ city: "Rapid City", state: "SD" }],
      remote: false,
    }));
    const pagesSeen: number[] = [];
    server.use(
      http.get(`${API}/bigco`, ({ request }) => {
        const page = Number.parseInt(new URL(request.url).searchParams.get("page") ?? "1", 10);
        pagesSeen.push(page);
        return HttpResponse.json({
          data: all.slice((page - 1) * 100, page * 100),
          count: total,
          page,
          page_size: 100,
        });
      }),
    );
    const out = await run({ slug: "bigco" });
    expect(out.result.jobs_count).toBe(total);
    expect(pagesSeen).toEqual([1, 2]);
  });

  it("stops after one page when count fits exactly in a full page", async () => {
    const total = 100;
    const all = Array.from({ length: total }, (_, i) => ({
      id: 600000 + i,
      name: `Role ${i}`,
      status: "Open",
      remote: false,
    }));
    const pagesSeen: number[] = [];
    server.use(
      http.get(`${API}/fullco`, ({ request }) => {
        pagesSeen.push(Number.parseInt(new URL(request.url).searchParams.get("page") ?? "1", 10));
        return HttpResponse.json({ data: all, count: total, page: 1, page_size: 100 });
      }),
    );
    const out = await run({ slug: "fullco" });
    expect(out.result.jobs_count).toBe(total);
    expect(pagesSeen).toEqual([1]);
  });

  it("returns success with zero jobs for an empty board", async () => {
    server.use(
      http.get(`${API}/emptyco`, () =>
        HttpResponse.json({ data: [], count: 0, page: 1, page_size: 100 }),
      ),
    );
    const out = await run({ slug: "emptyco" });
    expect(out.result.status).toBe("success");
    expect(out.result.jobs_count).toBe(0);
  });

  it("returns success with zero jobs when the response has no data array", async () => {
    server.use(http.get(`${API}/nodata`, () => HttpResponse.json({})));
    const out = await run({ slug: "nodata" });
    expect(out.result.status).toBe("success");
    expect(out.result.jobs_count).toBe(0);
  });

  it("retries on 5xx then succeeds", async () => {
    let attempts = 0;
    server.use(
      http.get(`${API}/flakeco`, () => {
        attempts += 1;
        if (attempts < 2) return new HttpResponse("err", { status: 503 });
        return HttpResponse.json(readFixture("hireology.small.json"));
      }),
    );
    const out = await run({ slug: "flakeco" });
    expect(attempts).toBe(2);
    expect(out.result.status).toBe("success");
  });

  it("honors Retry-After on 429 then succeeds", async () => {
    let attempts = 0;
    server.use(
      http.get(`${API}/throttleco`, () => {
        attempts += 1;
        if (attempts < 2) {
          return new HttpResponse("slow down", { status: 429, headers: { "retry-after": "0" } });
        }
        return HttpResponse.json(readFixture("hireology.small.json"));
      }),
    );
    const out = await run({ slug: "throttleco" });
    expect(attempts).toBe(2);
    expect(out.result.status).toBe("success");
  });

  it("marks the tenant transient_failure on exhausted retries", async () => {
    server.use(http.get(`${API}/downco`, () => new HttpResponse("err", { status: 502 })));
    const out = await run({ slug: "downco" });
    expect(out.result.status).toBe("transient_failure");
  });

  it("marks the tenant dead on 404", async () => {
    server.use(http.get(`${API}/goneco`, () => new HttpResponse("not found", { status: 404 })));
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
    const out = await scrapeHireologyTenant({
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
    server.use(
      http.get(`${API}/homeinstead-evansvillein`, () =>
        HttpResponse.json(readFixture("hireology.small.json")),
      ),
    );
    const out = await run({ slug: "homeinstead-evansvillein" });
    expect(out.result.status).toBe("success");
    expect(out.result.jobs_count).toBe(2);
  });
});
