import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from "bun:test";
import fc from "fast-check";
import { parseSchoolSpring, scrapeSchoolSpringTenant } from "../../src/ats/schoolspring.ts";
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
const COUNT_URL = "https://api.schoolspring.com/api/Jobs/GetJobsCountWithSearch";
const LIST_URL = "https://api.schoolspring.com/api/Jobs/GetPagedJobsWithSearch";

const server = makeServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function countJson(value: number) {
  return { success: true, message: "", validationErrors: [], value };
}

function pageJson(jobsList: unknown[], page = 1, size = jobsList.length) {
  return {
    success: true,
    message: "",
    validationErrors: [],
    value: { page, size, jobsList },
  };
}

function rows(start: number, n: number): unknown[] {
  return Array.from({ length: n }, (_, i) => ({
    jobId: start + i,
    employer: `District ${start + i}`,
    title: `Teacher ${start + i}`,
    location: "Springfield, Illinois",
    displayDate: "2026-06-30T08:00:00",
  }));
}

describe("parseSchoolSpring (fixture replay)", () => {
  it("parses the small fixture: per-row employer as company, location and posted_at", () => {
    const jobs = parseSchoolSpring({
      tenant: { slug: "schoolspring", display_name: "SchoolSpring" },
      response: readFixture("schoolspring.small.json"),
      observedAt: OBSERVED_AT,
    });
    expect(jobs).toHaveLength(2);
    const coach = jobs.find((j) => j.source_id === "5815345");
    expect(coach?.title).toBe("Assistant Coach Varsity Baseball");
    expect(coach?.company).toBe("Beaufort County School District");
    expect(coach?.location_text).toBe("Bluffton, South Carolina");
    // Naive vendor timestamps are read as UTC but never allowed past the
    // observation instant — this fixture row is same-day, so it clamps.
    expect(coach?.posted_at).toBe("2026-07-03T00:00:00.000Z");
    expect(coach?.url).toBe("https://www.schoolspring.com/jobdetail?jobId=5815345");
    const teacher = jobs.find((j) => j.source_id === "5815343");
    expect(teacher?.company).toBe("Middletown City Schools");
    expect(teacher?.ats).toBe("schoolspring");
    expect(teacher?.tenant_slug).toBe("schoolspring");
  });

  it("parses the large fixture: entities decoded, remote flagged, recruiter flagged", () => {
    const jobs = parseSchoolSpring({
      tenant: { slug: "schoolspring" },
      response: readFixture("schoolspring.large.json"),
      observedAt: OBSERVED_AT,
    });
    expect(jobs).toHaveLength(6);

    const cafe = jobs.find((j) => j.source_id === "5815160");
    expect(cafe?.title).toBe("Child Nutrition Café Special Programs");

    const chem = jobs.find((j) => j.source_id === "5815379");
    expect(chem?.title).toBe("High School Science Teacher (Chemistry & Electives)");

    const pool = jobs.find((j) => j.source_id === "5815398");
    expect(pool?.title).toBe("Early Childhood Education Teacher Pool ($55,948+)");

    const remote = jobs.find((j) => j.source_id === "5798716");
    expect(remote?.workplace_type).toBe("remote");

    const recruiter = jobs.find((j) => j.source_id === "5801234");
    expect(recruiter?.is_recruiter_post).toBe(true);

    // Non-remote titles stay unclassified — "City, State" carries no
    // workplace signal.
    const coordinator = jobs.find((j) => j.source_id === "5815342");
    expect(coordinator?.workplace_type).toBeNull();
    expect(coordinator?.posted_at).toBe("2026-07-03T00:00:00.000Z");
  });

  it("handles the edge fixture: skips, clamps, dedupes and falls back per row", () => {
    const jobs = parseSchoolSpring({
      tenant: { slug: "schoolspring", display_name: "SchoolSpring" },
      response: readFixture("schoolspring.edge.json"),
      observedAt: OBSERVED_AT,
    });
    // 9 rows: entity title kept, missing displayDate kept, empty location
    // kept, duplicate jobId deduped, malformed row skipped, future
    // displayDate clamped, missing jobId dropped, whitespace title
    // dropped, null employer falls back to the tenant display name —
    // five rows survive.
    expect(jobs).toHaveLength(5);
    expect(jobs.map((j) => j.source_id).sort()).toEqual(
      ["9001", "9002", "9003", "9006", "9009"].sort(),
    );

    const cafe = jobs.find((j) => j.source_id === "9001");
    expect(cafe?.title).toBe("Child Nutrition Café Special Programs");
    expect(cafe?.posted_at).toBe("2026-04-01T06:00:00.000Z");

    const noDate = jobs.find((j) => j.source_id === "9002");
    expect(noDate?.posted_at).toBeUndefined();

    const noLoc = jobs.find((j) => j.source_id === "9003");
    expect(noLoc?.location_text).toBeUndefined();

    const future = jobs.find((j) => j.source_id === "9006");
    expect(future?.posted_at).toBe("2026-07-03T00:00:00.000Z");

    const fallback = jobs.find((j) => j.source_id === "9009");
    expect(fallback?.company).toBe("SchoolSpring");
  });

  it("emits exactly one job per surviving jobId (no duplicate ids)", () => {
    const jobs = parseSchoolSpring({
      tenant: { slug: "schoolspring" },
      response: readFixture("schoolspring.edge.json"),
      observedAt: OBSERVED_AT,
    });
    const ids = jobs.map((j) => j.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("returns an empty array for an empty jobsList", () => {
    expect(
      parseSchoolSpring({
        tenant: { slug: "schoolspring" },
        response: pageJson([]),
        observedAt: OBSERVED_AT,
      }),
    ).toEqual([]);
  });

  it("throws on a success:false envelope, surfacing validationErrors", () => {
    expect(() =>
      parseSchoolSpring({
        tenant: { slug: "schoolspring" },
        response: {
          success: false,
          message: "Invalid search",
          validationErrors: ["size must be positive"],
          value: null,
        },
        observedAt: OBSERVED_AT,
      }),
    ).toThrow(/success=false.*Invalid search.*size must be positive/s);
  });

  it("accepts string jobIds and drops unparseable displayDate without dropping the row", () => {
    const jobs = parseSchoolSpring({
      tenant: { slug: "schoolspring" },
      response: pageJson([
        {
          jobId: "7001",
          employer: "String Id District",
          title: "Librarian",
          location: "Salem, Oregon",
          displayDate: "not a date",
        },
      ]),
      observedAt: OBSERVED_AT,
    });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.source_id).toBe("7001");
    expect(jobs[0]?.posted_at).toBeUndefined();
  });

  it("passes an already-zoned displayDate through without double-suffixing", () => {
    const jobs = parseSchoolSpring({
      tenant: { slug: "schoolspring" },
      response: pageJson([
        {
          jobId: 7002,
          employer: "Zoned District",
          title: "Counselor",
          location: "Reno, Nevada",
          displayDate: "2026-06-01T00:00:00-04:00",
        },
      ]),
      observedAt: OBSERVED_AT,
    });
    expect(jobs[0]?.posted_at).toBe("2026-06-01T04:00:00.000Z");
  });
});

describe("parseSchoolSpring (property)", () => {
  it("is deterministic across repeated invocations on the same input", () => {
    const fixtures = [
      readFixture("schoolspring.small.json"),
      readFixture("schoolspring.large.json"),
      readFixture("schoolspring.edge.json"),
    ];
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2 }), (i) => {
        const fixture = fixtures[i];
        const a = parseSchoolSpring({
          tenant: { slug: "schoolspring" },
          response: fixture,
          observedAt: OBSERVED_AT,
        });
        const b = parseSchoolSpring({
          tenant: { slug: "schoolspring" },
          response: fixture,
          observedAt: OBSERVED_AT,
        });
        return JSON.stringify(a) === JSON.stringify(b);
      }),
      { numRuns: 21 },
    );
  });

  it("never emits a posted_at later than observedAt", () => {
    fc.assert(
      fc.property(
        fc.date({
          min: new Date("2000-01-01T00:00:00Z"),
          max: new Date("2100-01-01T00:00:00Z"),
          noInvalidDate: true,
        }),
        (d) => {
          const naive = d.toISOString().slice(0, 19);
          const jobs = parseSchoolSpring({
            tenant: { slug: "schoolspring" },
            response: pageJson([
              {
                jobId: 1,
                employer: "E",
                title: "T",
                location: "A, B",
                displayDate: naive,
              },
            ]),
            observedAt: OBSERVED_AT,
          });
          const posted = jobs[0]?.posted_at;
          return posted !== undefined && Date.parse(posted) <= Date.parse(OBSERVED_AT);
        },
      ),
      { numRuns: 50 },
    );
  });
});

describe("scrapeSchoolSpringTenant", () => {
  it("rejects a slug other than 'schoolspring' without making a request", async () => {
    let calls = 0;
    server.use(
      http.get(COUNT_URL, () => {
        calls += 1;
        return HttpResponse.json(countJson(0));
      }),
    );
    const out = await scrapeSchoolSpringTenant({
      tenant: { slug: "not-schoolspring" },
      client: clientWithRobotsAllowAll(),
      observedAt: OBSERVED_AT,
    });
    expect(out.result.status).toBe("dead");
    expect(out.result.error).toContain("single-tenant");
    expect(calls).toBe(0);
  });

  it("fetches the count then paginates until the count is reached", async () => {
    let listCalls = 0;
    server.use(
      http.get(COUNT_URL, () => HttpResponse.json(countJson(5))),
      http.get(LIST_URL, ({ request }) => {
        listCalls += 1;
        const url = new URL(request.url);
        const page = Number.parseInt(url.searchParams.get("page") ?? "0", 10);
        expect(url.searchParams.get("size")).toBe("3");
        if (page === 1) return HttpResponse.json(pageJson(rows(100, 3), 1, 3));
        return HttpResponse.json(pageJson(rows(200, 2), 2, 3));
      }),
    );
    const out = await scrapeSchoolSpringTenant({
      tenant: { slug: "schoolspring", display_name: "SchoolSpring" },
      client: clientWithRobotsAllowAll(),
      observedAt: OBSERVED_AT,
      pageSize: 3,
    });
    expect(listCalls).toBe(2);
    expect(out.result.status).toBe("success");
    expect(out.result.jobs_count).toBe(5);
  });

  it("terminates on an empty page even when the advertised count says otherwise", async () => {
    let listCalls = 0;
    server.use(
      http.get(COUNT_URL, () => HttpResponse.json(countJson(1000))),
      http.get(LIST_URL, ({ request }) => {
        listCalls += 1;
        const page = Number.parseInt(new URL(request.url).searchParams.get("page") ?? "0", 10);
        if (page === 1) return HttpResponse.json(pageJson(rows(100, 3), 1, 3));
        // The vendor answers 200 + empty jobsList past the last page.
        return HttpResponse.json(pageJson([], page, 3));
      }),
    );
    const out = await scrapeSchoolSpringTenant({
      tenant: { slug: "schoolspring" },
      client: clientWithRobotsAllowAll(),
      observedAt: OBSERVED_AT,
      pageSize: 3,
    });
    expect(listCalls).toBe(2);
    expect(out.result.status).toBe("success");
    expect(out.result.jobs_count).toBe(3);
  });

  it("respects the maxPages cap when the vendor keeps serving full pages", async () => {
    let listCalls = 0;
    server.use(
      http.get(COUNT_URL, () => HttpResponse.json(countJson(1_000_000))),
      http.get(LIST_URL, () => {
        listCalls += 1;
        return HttpResponse.json(pageJson(rows(listCalls * 1000, 3), listCalls, 3));
      }),
    );
    const out = await scrapeSchoolSpringTenant({
      tenant: { slug: "schoolspring" },
      client: clientWithRobotsAllowAll(),
      observedAt: OBSERVED_AT,
      pageSize: 3,
      maxPages: 4,
    });
    expect(listCalls).toBe(4);
    expect(out.result.status).toBe("success");
    expect(out.result.jobs_count).toBe(12);
  });

  it("marks the tenant dead on a success:false list envelope", async () => {
    server.use(
      http.get(COUNT_URL, () => HttpResponse.json(countJson(10))),
      http.get(LIST_URL, () =>
        HttpResponse.json({
          success: false,
          message: "search rejected",
          validationErrors: ["organization not found"],
          value: null,
        }),
      ),
    );
    const out = await scrapeSchoolSpringTenant({
      tenant: { slug: "schoolspring" },
      client: clientWithRobotsAllowAll(),
      observedAt: OBSERVED_AT,
    });
    expect(out.result.status).toBe("dead");
    expect(out.result.error).toContain("success=false");
    expect(out.jobs).toEqual([]);
  });

  it("marks the tenant dead on a success:false count envelope", async () => {
    server.use(
      http.get(COUNT_URL, () =>
        HttpResponse.json({ success: false, message: "nope", validationErrors: [], value: null }),
      ),
    );
    const out = await scrapeSchoolSpringTenant({
      tenant: { slug: "schoolspring" },
      client: clientWithRobotsAllowAll(),
      observedAt: OBSERVED_AT,
    });
    expect(out.result.status).toBe("dead");
    expect(out.result.error).toContain("success=false");
  });

  it("retries on 5xx then succeeds", async () => {
    let countCalls = 0;
    server.use(
      http.get(COUNT_URL, () => {
        countCalls += 1;
        return countCalls < 2
          ? new HttpResponse("err", { status: 503 })
          : HttpResponse.json(countJson(2));
      }),
      http.get(LIST_URL, () => HttpResponse.json(readFixture("schoolspring.small.json"))),
    );
    const out = await scrapeSchoolSpringTenant({
      tenant: { slug: "schoolspring" },
      client: clientWithRobotsAllowAll(),
      observedAt: OBSERVED_AT,
    });
    expect(countCalls).toBe(2);
    expect(out.result.status).toBe("success");
    expect(out.result.jobs_count).toBe(2);
  });

  it("marks dead on 404 and transient on exhausted 5xx", async () => {
    server.use(http.get(COUNT_URL, () => new HttpResponse("no", { status: 404 })));
    const dead = await scrapeSchoolSpringTenant({
      tenant: { slug: "schoolspring" },
      client: clientWithRobotsAllowAll(),
      observedAt: OBSERVED_AT,
    });
    expect(dead.result.status).toBe("dead");

    server.resetHandlers();
    server.use(http.get(COUNT_URL, () => new HttpResponse("err", { status: 502 })));
    const transient = await scrapeSchoolSpringTenant({
      tenant: { slug: "schoolspring" },
      client: clientWithRobotsAllowAll(),
      observedAt: OBSERVED_AT,
    });
    expect(transient.result.status).toBe("transient_failure");
    expect(transient.jobs).toEqual([]);
  });

  it("blocks on robots.txt Disallow: / on api.schoolspring.com", async () => {
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
    const out = await scrapeSchoolSpringTenant({
      tenant: { slug: "schoolspring" },
      client,
      observedAt: OBSERVED_AT,
    });
    expect(out.result.status).toBe("dead");
    expect(out.result.error).toContain("robots.txt");
  });
});
