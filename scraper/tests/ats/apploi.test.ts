import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from "bun:test";
import type { TenantInput } from "@openroles/shared";
import fc from "fast-check";
import { apploiBrandRows, parseApploiJobs, scrapeApploiTenant } from "../../src/ats/apploi.ts";
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
const BRAND = "Acme Health";
const SEARCH_PATH = "https://ats-integrations.apploi.com/search/jobs/";

const server = makeServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function parseFixture(
  name: string,
  opts: { slug?: string; company?: string; brand?: string } = {},
): ReturnType<typeof parseApploiJobs> {
  return parseApploiJobs({
    tenant: { slug: opts.slug ?? "acme-health" },
    company: opts.company ?? "Acme Health",
    brand: opts.brand ?? BRAND,
    response: readFixture(name),
    observedAt: OBSERVED_AT,
  });
}

function run(
  tenant: TenantInput,
  overrides: { brand?: string } = {},
): ReturnType<typeof scrapeApploiTenant> {
  return scrapeApploiTenant({
    tenant,
    client: clientWithRobotsAllowAll(),
    observedAt: OBSERVED_AT,
    brand: overrides.brand ?? BRAND,
  });
}

// Build a search-response page in the live envelope shape — used to drive
// the pagination tests with synthetic full pages.
function apploiPage(rows: object[]): object {
  return { data: rows, elasticsearch_errors: [], errors: [], buckets: [] };
}

function apploiRow(i: number, brandName = BRAND): object {
  return {
    brand_name: brandName,
    city: "Austin",
    state: "Texas",
    id: String(800000 + i),
    name: `Role ${i}`,
    published_date: "2026-05-01",
    salary_min: 0,
    salary_max: 0,
    description: "<p>Care for patients.</p>",
  };
}

describe("apploiBrandRows", () => {
  it("keeps only rows whose brand_name matches the tenant brand exactly", () => {
    const rows = apploiBrandRows(readFixture("apploi.edge.json"), "Edge Care");
    expect(rows.length).toBe(8);
    expect(rows.some((r) => r.brand_name === "Other Facility")).toBe(false);
  });

  it("returns no rows for a null / non-object / missing-data response", () => {
    expect(apploiBrandRows(null, BRAND)).toEqual([]);
    expect(apploiBrandRows("nope", BRAND)).toEqual([]);
    expect(apploiBrandRows({}, BRAND)).toEqual([]);
    expect(apploiBrandRows({ data: "nope" }, BRAND)).toEqual([]);
    expect(apploiBrandRows({ data: [null, 7] }, BRAND)).toEqual([]);
  });
});

describe("parseApploiJobs (fixture replay)", () => {
  it("parses the small fixture into validated, deep-linked Jobs", () => {
    const jobs = parseFixture("apploi.small.json");
    expect(jobs).toHaveLength(2);
    const rn = jobs.find((j) => j.title === "Registered Nurse (RN)");
    expect(rn?.source_id).toBe("900001");
    expect(rn?.url).toBe("https://jobs.apploi.com/view/900001");
    expect(rn?.company).toBe("Acme Health");
    expect(rn?.location_text).toBe("Austin, Texas");
    expect(rn?.posted_at).toBe("2026-05-20T00:00:00.000Z");
    expect(rn?.description_excerpt).toContain("Provide direct patient care");
    expect(rn?.description_excerpt).toContain("discharge planning");
    expect(rn?.description_excerpt).not.toContain("<p>");
    // Hourly range rounded to whole units per the integer compensation schema.
    expect(rn?.compensation_min).toBe(39);
    expect(rn?.compensation_max).toBe(45);
    // Zeroed salary fields mean "not published" — no compensation emitted.
    const hha = jobs.find((j) => j.title === "Home Health Aide (HHA)");
    expect(hha?.compensation_min).toBeUndefined();
    expect(hha?.compensation_max).toBeUndefined();
    expect(new Set(jobs.map((j) => j.id)).size).toBe(jobs.length);
  });

  it("parses the large fixture with workplace + recruiter classification", () => {
    const jobs = parseFixture("apploi.large.json");
    expect(jobs).toHaveLength(6);
    const byTitle = (t: string) => jobs.find((j) => j.title === t);
    expect(byTitle("Remote Intake Coordinator")?.workplace_type).toBe("remote");
    expect(byTitle("Dietary Aide (Onsite)")?.workplace_type).toBe("onsite");
    expect(byTitle("Cardiac Registered Nurse")?.workplace_type).toBeNull();
    expect(byTitle("Technical Recruiter")?.is_recruiter_post).toBe(true);
    expect(byTitle("Cardiac Registered Nurse")?.is_recruiter_post).toBe(false);
    // Exact-amount salary maps to an equal min/max pair.
    expect(byTitle("Maintenance Technician")?.compensation_min).toBe(20);
    expect(byTitle("Maintenance Technician")?.compensation_max).toBe(20);
    expect(jobs.every((j) => j.url.startsWith("https://jobs.apploi.com/view/"))).toBe(true);
  });

  it("skips malformed rows and normalises edge cases", () => {
    const jobs = parseFixture("apploi.edge.json", {
      slug: "edge-care",
      company: "Edge Care",
      brand: "Edge Care",
    });
    // 9 rows: brand mismatch filtered, missing id + missing name skipped,
    // duplicate id deduped → 5 survive.
    expect(jobs).toHaveLength(5);
    expect(jobs.some((j) => j.title === "Fuzzy Match Leak")).toBe(false);
    expect(jobs.some((j) => j.title === "No Id Role")).toBe(false);
    expect(jobs.some((j) => j.title === "Duplicate Id Role")).toBe(false);

    const byTitle = (t: string) => jobs.find((j) => j.title === t);
    // Missing published_date → no posted_at.
    expect(byTitle("State Tested Nursing Assistant (STNA)")?.posted_at).toBeUndefined();
    // Future published_date clamped away (posted_at must be <= last_seen_at).
    expect(byTitle("Future Posted Role")?.posted_at).toBeUndefined();
    // Null city → the state alone is the location; entity-encoded title
    // decoded; whitespace-only description → no excerpt.
    const chef = byTitle("Chef & Dietary Manager");
    expect(chef).toBeDefined();
    expect(chef?.location_text).toBe("Ohio");
    expect(chef?.description_excerpt).toBeUndefined();
    // Inverted salary pair dropped whole.
    expect(byTitle("Inverted Salary Role")?.compensation_min).toBeUndefined();
    expect(byTitle("Inverted Salary Role")?.compensation_max).toBeUndefined();
    // Single-sided salary keeps the populated side.
    expect(byTitle("Remote Scheduler")?.compensation_min).toBe(19);
    expect(byTitle("Remote Scheduler")?.compensation_max).toBeUndefined();
    expect(byTitle("Remote Scheduler")?.workplace_type).toBe("remote");
  });

  it("returns no jobs on an empty or shapeless response", () => {
    expect(
      parseApploiJobs({
        tenant: { slug: "acme-health" },
        company: "Acme Health",
        brand: BRAND,
        response: {},
        observedAt: OBSERVED_AT,
      }),
    ).toHaveLength(0);
  });
});

describe("parseApploiJobs (property)", () => {
  it("is deterministic on identical input", () => {
    const fixtures = ["apploi.small.json", "apploi.large.json", "apploi.edge.json"].map((n) =>
      readFixture(n),
    );
    fc.assert(
      fc.property(
        fc.constantFrom(...fixtures),
        fc.constantFrom("Acme Health", "Edge Care"),
        (fixture, brand) => {
          const input = {
            tenant: { slug: "acme-health" },
            company: brand,
            brand,
            response: fixture,
            observedAt: OBSERVED_AT,
          };
          const a = parseApploiJobs(input);
          const b = parseApploiJobs(input);
          return JSON.stringify(a) === JSON.stringify(b);
        },
      ),
      { numRuns: 20 },
    );
  });
});

describe("scrapeApploiTenant", () => {
  it("hits the search endpoint with an encoded brand and returns success", async () => {
    const brands: (string | null)[] = [];
    server.use(
      http.get(SEARCH_PATH, ({ request }) => {
        brands.push(new URL(request.url).searchParams.get("brand"));
        return HttpResponse.json(readFixture("apploi.small.json"));
      }),
    );
    const out = await run(
      { slug: "acme-health", display_name: "Acme Health & Rehab" },
      { brand: "Acme Health" },
    );
    expect(out.result.status).toBe("success");
    expect(out.result.jobs_count).toBe(2);
    expect(out.result.http_status).toBe(200);
    expect(brands).toEqual(["Acme Health"]);
    // The row's brand_name (the exact brand) names the company, not the
    // tenant display_name.
    expect(out.jobs[0]?.company).toBe("Acme Health");
  });

  it("paginates full pages and stops on the first short page", async () => {
    const pages: number[] = [];
    server.use(
      http.get(SEARCH_PATH, ({ request }) => {
        const page = Number.parseInt(new URL(request.url).searchParams.get("page") ?? "0", 10);
        pages.push(page);
        const rows =
          page === 1
            ? Array.from({ length: 100 }, (_, i) => apploiRow(i))
            : Array.from({ length: 15 }, (_, i) => apploiRow(100 + i));
        return HttpResponse.json(apploiPage(rows));
      }),
    );
    const out = await run({ slug: "acme-health" });
    expect(out.result.jobs_count).toBe(115);
    expect(pages).toEqual([1, 2]);
  });

  it("stops paginating once fuzzy-matched foreign brands appear (mixed page)", async () => {
    // The brand parameter is a relevance search: after the exact-brand rows
    // run out, the API keeps returning full pages of other brands. A page
    // that mixes exact rows with foreign ones is the exhaustion boundary.
    const pages: number[] = [];
    server.use(
      http.get(SEARCH_PATH, ({ request }) => {
        const page = Number.parseInt(new URL(request.url).searchParams.get("page") ?? "0", 10);
        pages.push(page);
        const rows =
          page === 1
            ? Array.from({ length: 100 }, (_, i) => apploiRow(i))
            : [
                ...Array.from({ length: 15 }, (_, i) => apploiRow(100 + i)),
                ...Array.from({ length: 85 }, (_, i) => apploiRow(200 + i, "Someone Else")),
              ];
        return HttpResponse.json(apploiPage(rows));
      }),
    );
    const out = await run({ slug: "acme-health" });
    expect(out.result.jobs_count).toBe(115);
    expect(pages).toEqual([1, 2]);
    expect(out.jobs.every((j) => j.company === BRAND)).toBe(true);
  });

  it("retains a full exact page when the next page is entirely foreign", async () => {
    // Pure boundary: the brand's rows end exactly at a page edge, so page 2
    // is 100% fuzzy tail. The walk must stop after page 2 with every one of
    // the 100 exact jobs retained — no truncation.
    const pages: number[] = [];
    server.use(
      http.get(SEARCH_PATH, ({ request }) => {
        const page = Number.parseInt(new URL(request.url).searchParams.get("page") ?? "0", 10);
        pages.push(page);
        const rows =
          page === 1
            ? Array.from({ length: 100 }, (_, i) => apploiRow(i))
            : Array.from({ length: 100 }, (_, i) => apploiRow(500 + i, "Someone Else"));
        return HttpResponse.json(apploiPage(rows));
      }),
    );
    const out = await run({ slug: "acme-health" });
    expect(out.result.status).toBe("success");
    expect(out.result.jobs_count).toBe(100);
    expect(pages).toEqual([1, 2]);
    expect(out.jobs.every((j) => j.company === BRAND)).toBe(true);
  });

  it("URL-encodes a brand with special characters on the wire", async () => {
    const brand = "Foo & Bar Health";
    const rawQueries: string[] = [];
    server.use(
      http.get(SEARCH_PATH, ({ request }) => {
        rawQueries.push(new URL(request.url).search);
        return HttpResponse.json(apploiPage([apploiRow(1, brand), apploiRow(2, brand)]));
      }),
    );
    const out = await run({ slug: "foo-bar-health" }, { brand });
    expect(out.result.status).toBe("success");
    expect(out.result.jobs_count).toBe(2);
    // The raw query string carries the percent-encoded brand — the space
    // and ampersand must not survive literally (a bare `&` would split the
    // brand into a bogus extra parameter).
    expect(rawQueries).toEqual(["?page=1&size=100&brand=Foo%20%26%20Bar%20Health"]);
  });

  it("returns success with zero jobs when the brand matches nothing exactly", async () => {
    // An unknown brand still relevance-matches some unrelated tenant's rows
    // (observed live) — the exact-match filter empties page 1 and the loop
    // stops without a second request.
    const pages: number[] = [];
    server.use(
      http.get(SEARCH_PATH, ({ request }) => {
        pages.push(Number.parseInt(new URL(request.url).searchParams.get("page") ?? "0", 10));
        return HttpResponse.json(apploiPage([apploiRow(1, "XYZ Healthcare")]));
      }),
    );
    const out = await run({ slug: "acme-health" });
    expect(out.result.status).toBe("success");
    expect(out.result.jobs_count).toBe(0);
    expect(pages).toEqual([1]);
  });

  it("retries on 5xx then succeeds", async () => {
    let attempts = 0;
    server.use(
      http.get(SEARCH_PATH, () => {
        attempts += 1;
        if (attempts < 2) return new HttpResponse("err", { status: 503 });
        return HttpResponse.json(readFixture("apploi.small.json"));
      }),
    );
    const out = await run({ slug: "acme-health" });
    expect(attempts).toBe(2);
    expect(out.result.status).toBe("success");
  });

  it("honors Retry-After on 429 then succeeds", async () => {
    let attempts = 0;
    server.use(
      http.get(SEARCH_PATH, () => {
        attempts += 1;
        if (attempts < 2) {
          return new HttpResponse("slow down", { status: 429, headers: { "retry-after": "0" } });
        }
        return HttpResponse.json(readFixture("apploi.small.json"));
      }),
    );
    const out = await run({ slug: "acme-health" });
    expect(attempts).toBe(2);
    expect(out.result.status).toBe("success");
  });

  it("marks the tenant transient_failure on exhausted retries", async () => {
    server.use(http.get(SEARCH_PATH, () => new HttpResponse("err", { status: 502 })));
    const out = await run({ slug: "acme-health" });
    expect(out.result.status).toBe("transient_failure");
  });

  it("marks the tenant dead on 404", async () => {
    server.use(http.get(SEARCH_PATH, () => new HttpResponse("not found", { status: 404 })));
    const out = await run({ slug: "acme-health" });
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
    const client = new HttpClient({
      userAgent: "openroles/0.0.0 (+https://example.com)",
      robots: new RobotsTxtCache({ fetchFn: robotsFetch, clock: () => 0 }),
      sleep: async () => {},
      random: () => 0.5,
      retry: { maxAttempts: 1, baseMs: 1, maxMs: 1 },
    });
    const out = await scrapeApploiTenant({
      tenant: { slug: "blocked" },
      client,
      observedAt: OBSERVED_AT,
      brand: BRAND,
    });
    expect(out.result.status).toBe("dead");
    expect(out.result.error).toContain("robots.txt");
  });

  it("marks the tenant dead on an unsafe slug", async () => {
    const out = await run({ slug: "Bad_Slug" });
    expect(out.result.status).toBe("dead");
    expect(out.result.error).toContain("tenant slug rejected");
  });

  it("marks the tenant dead on a rejected brand string", async () => {
    for (const brand of ["", "   ", "bad\nbrand", "x".repeat(257)]) {
      const out = await run({ slug: "acme-health" }, { brand });
      expect(out.result.status).toBe("dead");
      expect(out.result.error).toContain("apploi brand rejected");
    }
  });
});
