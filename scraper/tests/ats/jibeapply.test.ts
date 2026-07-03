import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from "bun:test";
import type { TenantInput } from "@openroles/shared";
import fc from "fast-check";
import { parseJibeapplyJobs, scrapeJibeapplyTenant } from "../../src/ats/jibeapply.ts";
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
const HOST = "acme.jibeapply.com";
const API_PATH = `https://${HOST}/api/jobs`;

const server = makeServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function parseFixture(
  name: string,
  opts: { slug?: string; company?: string; host?: string } = {},
): ReturnType<typeof parseJibeapplyJobs> {
  const slug = opts.slug ?? "acme";
  return parseJibeapplyJobs({
    tenant: { slug },
    company: opts.company ?? "Acme Corp",
    host: opts.host ?? `${slug}.jibeapply.com`,
    response: readFixture(name),
    observedAt: OBSERVED_AT,
  });
}

function run(
  tenant: TenantInput,
  overrides: { host?: string } = {},
): ReturnType<typeof scrapeJibeapplyTenant> {
  return scrapeJibeapplyTenant({
    tenant,
    client: clientWithRobotsAllowAll(),
    observedAt: OBSERVED_AT,
    ...(overrides.host !== undefined ? { host: overrides.host } : {}),
  });
}

describe("parseJibeapplyJobs (fixture replay)", () => {
  it("parses the small fixture with excerpt, location, compensation and dates", () => {
    const jobs = parseFixture("jibeapply.small.json");
    expect(jobs).toHaveLength(2);
    const eng = jobs.find((j) => j.title === "Senior Security Engineer");
    expect(eng?.company).toBe("Acme Corp");
    expect(eng?.source_id).toBe("27341");
    expect(eng?.url).toBe(`https://${HOST}/jobs/27341`);
    expect(eng?.description_excerpt).toContain("Lead our threat detection");
    expect(eng?.description_excerpt).toContain("Build detections across the SIEM");
    expect(eng?.description_excerpt).not.toContain("<p>");
    expect(eng?.location_text).toBe("Savannah, Georgia");
    expect(eng?.department).toBe("Security Operations");
    expect(eng?.compensation_min).toBe(120000);
    expect(eng?.compensation_max).toBe(150000);
    expect(eng?.posted_at).toBe("2026-05-20T14:27:00.000Z");
    expect(eng?.updated_at).toBe("2026-05-21T17:14:56.000Z");

    const analyst = jobs.find((j) => j.title === "Remote Threat Intelligence Analyst");
    expect(analyst?.workplace_type).toBe("remote");
    // Zero salary sentinel means "not disclosed" — no compensation emitted.
    expect(analyst?.compensation_min).toBeUndefined();
    expect(analyst?.compensation_max).toBeUndefined();
    // Empty department string falls back to the first category name.
    expect(analyst?.department).toBe("Professional / Managerial / Administrative");
  });

  it("parses the large fixture into validated, deep-linked Jobs", () => {
    const jobs = parseFixture("jibeapply.large.json", { slug: "globex", company: "Globex" });
    expect(jobs).toHaveLength(6);
    const byTitle = (t: string) => jobs.find((j) => j.title === t);
    // Workplace inferred from the title/location text (no structured field).
    expect(byTitle("Senior Software Engineer, Payments")?.workplace_type).toBe("remote");
    expect(byTitle("Staff Threat Intelligence Analyst")?.workplace_type).toBe("hybrid");
    expect(byTitle("Principal Security Architect")?.workplace_type).toBe("onsite");
    expect(byTitle("Remote Incident Responder")?.workplace_type).toBe("remote");
    expect(byTitle("Technical Recruiter")?.workplace_type).toBeNull();
    expect(byTitle("Technical Recruiter")?.is_recruiter_post).toBe(true);
    // Fractional salary values round to the integer schema shape.
    expect(byTitle("Senior Software Engineer, Payments")?.compensation_min).toBe(58661);
    expect(byTitle("Senior Software Engineer, Payments")?.compensation_max).toBe(69331);
    // Empty full_location + empty city/state → no location at all.
    expect(byTitle("Remote Incident Responder")?.location_text).toBeUndefined();
    // Job URL deep-links to the public job card, not the apply login page.
    expect(byTitle("Junior Frontend Engineer")?.url).toBe(
      "https://globex.jibeapply.com/jobs/300006",
    );
    expect(jobs.every((j) => !j.url.includes("icims.com"))).toBe(true);
    expect(new Set(jobs.map((j) => j.id)).size).toBe(jobs.length);
  });

  it("skips malformed rows and normalises edge cases", () => {
    const jobs = parseFixture("jibeapply.edge.json", { slug: "edgeco", company: "Edge Co" });
    // Six raw rows: missing req_id and missing title are dropped, the
    // duplicate req_id is deduped — three validated jobs survive.
    expect(jobs).toHaveLength(3);
    expect(jobs.some((j) => j.title === "No Req Id Job")).toBe(false);

    const entities = jobs.find((j) => j.source_id === "400003");
    expect(entities?.title).toBe("R&D Engineer — Platform"); // entities decoded
    expect(entities?.compensation_min).toBeUndefined(); // salary nulls ignored
    expect(entities?.location_text).toBe("Vermont"); // empty city collapses out
    expect(entities?.posted_at).toBeUndefined(); // absent posted_date

    const future = jobs.find((j) => j.title === "Future Posted Role");
    expect(future?.posted_at).toBeUndefined(); // would violate posted_at <= last_seen_at
    expect(future?.updated_at).toBeUndefined(); // same clamp for update_date
    expect(future?.description_excerpt).toBeUndefined(); // whitespace-only description
    expect(future?.compensation_min).toBeUndefined(); // min > max glitch dropped
    expect(future?.compensation_max).toBeUndefined();

    const dupe = jobs.filter((j) => j.source_id === "400005");
    expect(dupe).toHaveLength(1);
    expect(dupe[0]?.title).toBe("Duplicate Req Role"); // first copy wins
    expect(dupe[0]?.posted_at).toBeUndefined(); // unparseable posted_date dropped
  });

  it("returns no jobs when the response has no jobs array", () => {
    expect(
      parseJibeapplyJobs({
        tenant: { slug: "acme" },
        company: "Acme",
        host: HOST,
        response: {},
        observedAt: OBSERVED_AT,
      }),
    ).toHaveLength(0);
  });
});

describe("parseJibeapplyJobs (property)", () => {
  it("is deterministic on identical input", () => {
    const fixture = readFixture("jibeapply.large.json");
    fc.assert(
      fc.property(fc.constantFrom("acme", "globex", "initech"), (slug) => {
        const input = {
          tenant: { slug },
          company: slug,
          host: `${slug}.jibeapply.com`,
          response: fixture,
          observedAt: OBSERVED_AT,
        };
        const a = parseJibeapplyJobs(input);
        const b = parseJibeapplyJobs(input);
        return JSON.stringify(a) === JSON.stringify(b);
      }),
      { numRuns: 20 },
    );
  });
});

describe("scrapeJibeapplyTenant", () => {
  it("hits the /api/jobs endpoint and returns success", async () => {
    server.use(http.get(API_PATH, () => HttpResponse.json(readFixture("jibeapply.small.json"))));
    const out = await run({ slug: "acme", display_name: "Acme Corp" });
    expect(out.result.status).toBe("success");
    expect(out.result.jobs_count).toBe(2);
    expect(out.result.http_status).toBe(200);
    expect(out.jobs[0]?.company).toBe("Acme Corp");
  });

  it("paginates with 1-based page numbers until totalCount is reached", async () => {
    const total = 150;
    const all = Array.from({ length: total }, (_, i) => ({
      data: {
        req_id: `req-${i}`,
        title: `Role ${i}`,
        full_location: "Remote, US",
        posted_date: "2026-05-01T00:00:00+0000",
      },
    }));
    const pagesSeen: number[] = [];
    server.use(
      http.get(API_PATH, ({ request }) => {
        const url = new URL(request.url);
        const page = Number.parseInt(url.searchParams.get("page") ?? "1", 10);
        const limit = Number.parseInt(url.searchParams.get("limit") ?? "10", 10);
        pagesSeen.push(page);
        expect(limit).toBe(100);
        return HttpResponse.json({
          jobs: all.slice((page - 1) * limit, page * limit),
          totalCount: total,
          count: total,
        });
      }),
    );
    const out = await run({ slug: "acme" });
    expect(out.result.jobs_count).toBe(total);
    expect(pagesSeen).toEqual([1, 2]);
  });

  it("returns success with zero jobs for an empty board", async () => {
    server.use(http.get(API_PATH, () => HttpResponse.json({ jobs: [], totalCount: 0, count: 0 })));
    const out = await run({ slug: "acme" });
    expect(out.result.status).toBe("success");
    expect(out.result.jobs_count).toBe(0);
  });

  it("stops after a short page even without a totalCount", async () => {
    server.use(
      http.get(API_PATH, () =>
        HttpResponse.json({ jobs: [{ data: { req_id: "1", title: "Solo Role" } }] }),
      ),
    );
    const out = await run({ slug: "acme" });
    expect(out.result.status).toBe("success");
    expect(out.result.jobs_count).toBe(1);
  });

  it("scrapes a vanity CNAME host when one is supplied", async () => {
    server.use(
      http.get("https://careers.acme-example.com/api/jobs", () =>
        HttpResponse.json(readFixture("jibeapply.small.json")),
      ),
    );
    const out = await run(
      { slug: "acme", display_name: "Acme Corp" },
      { host: "careers.acme-example.com" },
    );
    expect(out.result.status).toBe("success");
    expect(out.result.jobs_count).toBe(2);
    expect(out.jobs[0]?.url).toContain("https://careers.acme-example.com/jobs/");
  });

  it("marks the tenant dead on a rejected vanity host (SSRF guard)", async () => {
    for (const host of ["localhost", "169.254.169.254", "internal host", "[::1]"]) {
      const out = await run({ slug: "acme" }, { host });
      expect(out.result.status).toBe("dead");
      expect(out.jobs).toHaveLength(0);
      expect(out.result.error).toContain("jibeapply host rejected");
    }
  });

  it("retries on 5xx then succeeds", async () => {
    let attempts = 0;
    server.use(
      http.get(API_PATH, () => {
        attempts += 1;
        if (attempts < 2) return new HttpResponse("err", { status: 503 });
        return HttpResponse.json(readFixture("jibeapply.small.json"));
      }),
    );
    const out = await run({ slug: "acme" });
    expect(attempts).toBe(2);
    expect(out.result.status).toBe("success");
  });

  it("honors Retry-After on 429 then succeeds", async () => {
    let attempts = 0;
    server.use(
      http.get(API_PATH, () => {
        attempts += 1;
        if (attempts < 2) {
          return new HttpResponse("slow down", { status: 429, headers: { "retry-after": "0" } });
        }
        return HttpResponse.json(readFixture("jibeapply.small.json"));
      }),
    );
    const out = await run({ slug: "acme" });
    expect(attempts).toBe(2);
    expect(out.result.status).toBe("success");
  });

  it("marks the tenant transient_failure on exhausted retries", async () => {
    server.use(http.get(API_PATH, () => new HttpResponse("err", { status: 502 })));
    const out = await run({ slug: "acme" });
    expect(out.result.status).toBe("transient_failure");
  });

  it("marks the tenant dead on 404", async () => {
    server.use(http.get(API_PATH, () => new HttpResponse("not found", { status: 404 })));
    const out = await run({ slug: "acme" });
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
    const out = await scrapeJibeapplyTenant({
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
});
