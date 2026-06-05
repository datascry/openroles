import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from "bun:test";
import type { TenantInput } from "@openroles/shared";
import fc from "fast-check";
import { parseOracleRequisitions, scrapeOracleCloudTenant } from "../../src/ats/oraclecloud.ts";
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
const HOST = "etest.fa.us2.oraclecloud.com";
const SITE = "CX_1";
const REQ_PATH = `https://${HOST}/hcmRestApi/resources/latest/recruitingCEJobRequisitions`;

const server = makeServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function parseFixture(
  name: string,
  opts: { slug?: string; company?: string } = {},
): ReturnType<typeof parseOracleRequisitions> {
  return parseOracleRequisitions({
    tenant: { slug: opts.slug ?? "acme" },
    company: opts.company ?? "Acme Corp",
    host: HOST,
    site: SITE,
    response: readFixture(name),
    observedAt: OBSERVED_AT,
  });
}

function run(
  tenant: TenantInput,
  overrides: { host?: string; site?: string } = {},
): ReturnType<typeof scrapeOracleCloudTenant> {
  return scrapeOracleCloudTenant({
    tenant,
    client: clientWithRobotsAllowAll(),
    observedAt: OBSERVED_AT,
    host: overrides.host ?? HOST,
    site: overrides.site ?? SITE,
  });
}

describe("parseOracleRequisitions (fixture replay)", () => {
  it("parses the large fixture into validated, deep-linked Jobs", () => {
    const jobs = parseFixture("oraclecloud.large.json");
    expect(jobs).toHaveLength(6);
    expect(jobs.map((j) => j.title)).toEqual([
      "Senior Software Engineer, Payments",
      "Staff Threat Intelligence Analyst",
      "Principal Security Architect",
      "Technical Recruiter",
      "Remote Incident Responder",
      "Junior Frontend Engineer",
    ]);
    // Workplace taxonomy: explicit codes + the null→title fallback.
    const byTitle = (t: string) => jobs.find((j) => j.title === t);
    expect(byTitle("Senior Software Engineer, Payments")?.workplace_type).toBe("remote");
    expect(byTitle("Staff Threat Intelligence Analyst")?.workplace_type).toBe("hybrid");
    expect(byTitle("Principal Security Architect")?.workplace_type).toBe("onsite");
    expect(byTitle("Technical Recruiter")?.workplace_type).toBeNull();
    expect(byTitle("Remote Incident Responder")?.workplace_type).toBe("remote");
    // Recruiter classification, country + region parsing.
    expect(byTitle("Technical Recruiter")?.is_recruiter_post).toBe(true);
    expect(byTitle("Junior Frontend Engineer")?.location_country).toBe("CA");
    expect(byTitle("Junior Frontend Engineer")?.location_region).toBe("ON");
    expect(byTitle("Staff Threat Intelligence Analyst")?.location_country).toBe("GB");
    // Apply links deep-link to the specific job card.
    expect(byTitle("Senior Software Engineer, Payments")?.url).toBe(
      `https://${HOST}/hcmUI/CandidateExperience/en/sites/${SITE}/job/300001`,
    );
    expect(new Set(jobs.map((j) => j.id)).size).toBe(jobs.length);
  });

  it("parses the small fixture with excerpt, location and posted_at", () => {
    const jobs = parseFixture("oraclecloud.small.json");
    expect(jobs).toHaveLength(2);
    const eng = jobs.find((j) => j.title === "Senior Security Engineer");
    expect(eng?.company).toBe("Acme Corp");
    expect(eng?.description_excerpt).toContain("Lead our threat detection");
    expect(eng?.description_excerpt).toContain("Build detections across the SIEM");
    expect(eng?.description_excerpt).not.toContain("<p>");
    expect(eng?.location_text).toBe("Austin, TX, United States");
    expect(eng?.location_country).toBe("US");
    expect(eng?.location_region).toBe("TX");
    expect(eng?.workplace_type).toBe("remote");
    expect(eng?.department).toBe("Information Technology");
    expect(eng?.posted_at).toBe("2026-05-20T00:00:00.000Z");
    expect(
      jobs.find((j) => j.title === "Staff Threat Intelligence Analyst")?.location_country,
    ).toBe("GB");
  });

  it("skips malformed reqs and normalises edge cases", () => {
    const jobs = parseFixture("oraclecloud.edge.json", { slug: "edgeco", company: "Edge Co" });
    // Two of the six reqs (missing Id, missing Title) are dropped.
    expect(jobs).toHaveLength(4);
    expect(jobs.some((j) => j.title === "No Id Job")).toBe(false);

    const onsite = jobs.find((j) => j.title === "Onsite Line Cook");
    expect(onsite?.workplace_type).toBe("onsite");
    expect(onsite?.location_country).toBeUndefined(); // "usa" is not ISO 3166 alpha-2
    expect(onsite?.location_region).toBeUndefined(); // single-part location

    const remote = jobs.find((j) => j.title === "Remote Incident Responder");
    expect(remote?.workplace_type).toBe("remote"); // inferred from title when code is null

    const future = jobs.find((j) => j.title === "Future Posted Role");
    expect(future?.posted_at).toBeUndefined(); // dropped: would violate posted_at <= last_seen_at
    expect(future?.description_excerpt).toBeUndefined(); // whitespace-only blurb

    const ctrl = jobs.find((j) => j.title === "Control Char Description Role");
    expect(ctrl?.description_excerpt).toBe("Line one Line two with tab"); // control chars collapsed
    expect(ctrl?.description_excerpt).not.toMatch(/[\n\t]/);
  });

  it("returns no jobs when the response has no items", () => {
    expect(
      parseOracleRequisitions({
        tenant: { slug: "acme" },
        company: "Acme",
        host: HOST,
        site: SITE,
        response: {},
        observedAt: OBSERVED_AT,
      }),
    ).toHaveLength(0);
  });
});

describe("parseOracleRequisitions (property)", () => {
  it("is deterministic on identical input", () => {
    const fixture = readFixture("oraclecloud.large.json");
    fc.assert(
      fc.property(fc.constantFrom("acme", "globex", "initech"), (slug) => {
        const a = parseOracleRequisitions({
          tenant: { slug },
          company: slug,
          host: HOST,
          site: SITE,
          response: fixture,
          observedAt: OBSERVED_AT,
        });
        const b = parseOracleRequisitions({
          tenant: { slug },
          company: slug,
          host: HOST,
          site: SITE,
          response: fixture,
          observedAt: OBSERVED_AT,
        });
        return JSON.stringify(a) === JSON.stringify(b);
      }),
      { numRuns: 20 },
    );
  });
});

describe("scrapeOracleCloudTenant", () => {
  it("hits the requisitions endpoint and returns success", async () => {
    server.use(http.get(REQ_PATH, () => HttpResponse.json(readFixture("oraclecloud.small.json"))));
    const out = await run({ slug: "acme", display_name: "Acme Corp" });
    expect(out.result.status).toBe("success");
    expect(out.result.jobs_count).toBe(2);
    expect(out.result.http_status).toBe(200);
    expect(out.jobs[0]?.company).toBe("Acme Corp");
  });

  it("paginates across pages until TotalJobsCount is reached", async () => {
    const total = 150;
    const all = Array.from({ length: total }, (_, i) => ({
      Id: `req-${i}`,
      Title: `Role ${i}`,
      PostedDate: "2026-05-01",
      PrimaryLocation: "Remote, US",
      WorkplaceTypeCode: "ORA_REMOTE",
    }));
    const offsetsSeen: number[] = [];
    server.use(
      http.get(REQ_PATH, ({ request }) => {
        const m = /offset=(\d+)/.exec(request.url);
        const offset = m ? Number.parseInt(m[1] as string, 10) : 0;
        offsetsSeen.push(offset);
        return HttpResponse.json({
          items: [{ TotalJobsCount: total, requisitionList: all.slice(offset, offset + 100) }],
        });
      }),
    );
    const out = await run({ slug: "bigco" });
    expect(out.result.jobs_count).toBe(total);
    expect(offsetsSeen).toEqual([0, 100]);
  });

  it("returns success with zero jobs for an empty site", async () => {
    server.use(
      http.get(REQ_PATH, () =>
        HttpResponse.json({ items: [{ TotalJobsCount: 0, requisitionList: [] }] }),
      ),
    );
    const out = await run({ slug: "emptyco" });
    expect(out.result.status).toBe("success");
    expect(out.result.jobs_count).toBe(0);
  });

  it("returns success with zero jobs when the response has no items", async () => {
    server.use(http.get(REQ_PATH, () => HttpResponse.json({})));
    const out = await run({ slug: "noitems" });
    expect(out.result.status).toBe("success");
    expect(out.result.jobs_count).toBe(0);
  });

  it("retries on 5xx then succeeds", async () => {
    let attempts = 0;
    server.use(
      http.get(REQ_PATH, () => {
        attempts += 1;
        if (attempts < 2) return new HttpResponse("err", { status: 503 });
        return HttpResponse.json(readFixture("oraclecloud.small.json"));
      }),
    );
    const out = await run({ slug: "flakeco" });
    expect(attempts).toBe(2);
    expect(out.result.status).toBe("success");
  });

  it("honors Retry-After on 429 then succeeds", async () => {
    let attempts = 0;
    server.use(
      http.get(REQ_PATH, () => {
        attempts += 1;
        if (attempts < 2) {
          return new HttpResponse("slow down", { status: 429, headers: { "retry-after": "0" } });
        }
        return HttpResponse.json(readFixture("oraclecloud.small.json"));
      }),
    );
    const out = await run({ slug: "throttleco" });
    expect(attempts).toBe(2);
    expect(out.result.status).toBe("success");
  });

  it("marks the tenant transient_failure on exhausted retries", async () => {
    server.use(http.get(REQ_PATH, () => new HttpResponse("err", { status: 502 })));
    const out = await run({ slug: "downco" });
    expect(out.result.status).toBe("transient_failure");
  });

  it("marks the tenant dead on 404", async () => {
    server.use(http.get(REQ_PATH, () => new HttpResponse("not found", { status: 404 })));
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
    const out = await scrapeOracleCloudTenant({
      tenant: { slug: "blocked" },
      client,
      observedAt: OBSERVED_AT,
      host: HOST,
      site: SITE,
    });
    expect(out.result.status).toBe("dead");
    expect(out.result.error).toContain("robots.txt");
  });

  it("marks the tenant dead on a rejected pod host (SSRF guard)", async () => {
    const out = await run({ slug: "acme" }, { host: "evil.example.com" });
    expect(out.result.status).toBe("dead");
    expect(out.jobs).toHaveLength(0);
    expect(out.result.error).toContain("oraclecloud host rejected");
  });

  it("marks the tenant dead on a rejected site code", async () => {
    const out = await run({ slug: "acme" }, { site: "bad site!" });
    expect(out.result.status).toBe("dead");
    expect(out.result.error).toContain("oraclecloud site rejected");
  });

  it("marks the tenant dead on an unsafe slug", async () => {
    const out = await run({ slug: "Bad_Slug" });
    expect(out.result.status).toBe("dead");
    expect(out.result.error).toContain("tenant slug rejected");
  });
});
