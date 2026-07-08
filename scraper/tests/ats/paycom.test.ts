import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from "bun:test";
import type { TenantInput } from "@openroles/shared";
import fc from "fast-check";
import {
  extractPaycomSession,
  type PaycomDetail,
  parsePaycomPreviews,
  parsePaycomSalary,
  scrapePaycomTenant,
} from "../../src/ats/paycom.ts";
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

const OBSERVED_AT = "2026-07-04T00:00:00Z";
const SLUG = "b2bd1063bf1b0a2978ea308e72ccf7d3";
const CK_UPPER = SLUG.toUpperCase();
const CAREER_URL = `https://www.paycomonline.net/v4/ats/web.php/portal/${CK_UPPER}/career-page`;
const API_BASE = "https://portal-applicant-tracking.us-cent.paycomonline.net/";
const SEARCH_URL = `${API_BASE}api/ats/job-posting-previews/search`;
const DETAIL_URL = `${API_BASE}api/ats/job-postings/:id`;

const PORTAL = readFixtureText("paycom.portal.html");
const NOBOOT = readFixtureText("paycom.noboot.html");
const SSRF = readFixtureText("paycom.portal.ssrf.html");
const NOJWT = readFixtureText("paycom.portal.nojwt.html");
const SMALL = readFixture("paycom.search.small.json") as {
  jobPostingPreviews: unknown[];
  jobPostingPreviewsCount: number;
};
const EDGE = readFixture("paycom.search.edge.json") as { jobPostingPreviews: unknown[] };

const server = makeServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function detailsMap(name: string): Map<string, PaycomDetail> {
  return new Map(Object.entries(readFixture(name) as Record<string, PaycomDetail>));
}

function parse(
  previews: unknown[],
  opts: { slug?: string; company?: string; detailsName?: string } = {},
) {
  const slug = opts.slug ?? SLUG;
  return parsePaycomPreviews({
    tenant: { slug },
    clientKeyUpper: slug.toUpperCase(),
    company: opts.company ?? "Portal Inc",
    previews: previews as never,
    observedAt: OBSERVED_AT,
    ...(opts.detailsName ? { details: detailsMap(opts.detailsName) } : {}),
  });
}

// Serve the career page, the search POST (paginated on the request's skip),
// and each detail GET from the details fixture.
function serve(opts: { html?: string; detailsName?: string } = {}): void {
  const html = opts.html ?? PORTAL;
  server.use(
    http.get(CAREER_URL, () => new HttpResponse(html)),
    http.post(SEARCH_URL, async ({ request }) => {
      const { skip, take } = (await request.json()) as { skip: number; take: number };
      const all = SMALL.jobPostingPreviews;
      return HttpResponse.json({
        jobPostingPreviews: all.slice(skip, skip + take),
        jobPostingPreviewsCount: all.length,
      });
    }),
    http.get(DETAIL_URL, ({ params }) => {
      if (!opts.detailsName) return HttpResponse.json({ jobPosting: {} });
      const map = readFixture(opts.detailsName) as Record<string, unknown>;
      const rec = map[params["id"] as string];
      return rec
        ? HttpResponse.json({ jobPosting: rec })
        : new HttpResponse("not found", { status: 404 });
    }),
  );
}

function run(tenant: TenantInput, extra: Record<string, unknown> = {}) {
  return scrapePaycomTenant({
    tenant,
    client: clientWithRobotsAllowAll(),
    observedAt: OBSERVED_AT,
    perTenantConcurrency: 4,
    ...extra,
  });
}

describe("extractPaycomSession", () => {
  it("reads the JWT + SSRF-guarded API base from configsFromHost", () => {
    const s = extractPaycomSession(PORTAL);
    expect(s?.sessionJWT.startsWith("eyJ")).toBe(true);
    expect(s?.apiBase).toBe(API_BASE);
  });

  it("returns null when configsFromHost is absent (dead placeholder page)", () => {
    expect(extractPaycomSession(NOBOOT)).toBeNull();
    expect(extractPaycomSession("")).toBeNull();
  });

  it("returns null when the API host fails the SSRF pod guard", () => {
    expect(extractPaycomSession(SSRF)).toBeNull();
  });

  it("returns null when the session JWT is missing/blank", () => {
    expect(extractPaycomSession(NOJWT)).toBeNull();
  });

  it("returns null when the configsFromHost object never closes (unbalanced braces)", () => {
    expect(extractPaycomSession('<script>var configsFromHost = {"sessionJWT":"eyJx"')).toBeNull();
  });

  it("returns null on malformed configsFromHost / libConfig JSON", () => {
    expect(extractPaycomSession("<script>var configsFromHost = {not json};</script>")).toBeNull();
    expect(
      extractPaycomSession(
        '<script>var configsFromHost = {"sessionJWT":"eyJx","libConfig":"{bad"};</script>',
      ),
    ).toBeNull();
  });

  it("rejects a non-https or credentialed API base", () => {
    const httpBase =
      '<script>var configsFromHost = {"sessionJWT":"eyJx","libConfig":"{\\"atsPortalMantleServiceUrl\\":\\"http://portal-applicant-tracking.us-cent.paycomonline.net/\\"}"};</script>';
    expect(extractPaycomSession(httpBase)).toBeNull();
  });

  it("normalises a missing trailing slash on the API base", () => {
    const noSlash =
      '<script>var configsFromHost = {"sessionJWT":"eyJx","libConfig":"{\\"atsPortalMantleServiceUrl\\":\\"https://portal-applicant-tracking.us-east.paycomonline.net\\"}"};</script>';
    expect(extractPaycomSession(noSlash)?.apiBase).toBe(
      "https://portal-applicant-tracking.us-east.paycomonline.net/",
    );
  });
});

describe("parsePaycomSalary", () => {
  it("parses single and ranged dollar figures", () => {
    expect(parsePaycomSalary("$15.00 Hourly")).toEqual({ min: 15 });
    expect(parsePaycomSalary("$40,000.00 - $52,000.00 Annually")).toEqual({
      min: 40000,
      max: 52000,
    });
  });

  it("drops non-numeric, zero and inverted ranges", () => {
    expect(parsePaycomSalary("DOE")).toEqual({});
    expect(parsePaycomSalary("")).toEqual({});
    expect(parsePaycomSalary(null)).toEqual({});
    expect(parsePaycomSalary("$0.00")).toEqual({});
    expect(parsePaycomSalary("$30.00 - $20.00 Hourly")).toEqual({});
  });

  it("upholds its invariants over arbitrary two-figure ranges (property)", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 1_000_000, noNaN: true }),
        fc.double({ min: 0, max: 1_000_000, noNaN: true }),
        fc.constantFrom("Hourly", "Annually", ""),
        (a, b, unit) => {
          const out = parsePaycomSalary(`$${a} - $${b} ${unit}`);
          // Emitted figures are always positive integers.
          if (out.min !== undefined) {
            expect(Number.isInteger(out.min)).toBe(true);
            expect(out.min).toBeGreaterThan(0);
          }
          if (out.max !== undefined) {
            expect(Number.isInteger(out.max)).toBe(true);
            expect(out.max).toBeGreaterThan(0);
            // A max is only ever emitted alongside a min it is >= to.
            expect(out.min).toBeDefined();
            expect(out.min as number).toBeLessThanOrEqual(out.max);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe("parsePaycomPreviews (fixture replay)", () => {
  it("merges previews + detail into validated, deep-linked Jobs", () => {
    const jobs = parse(SMALL.jobPostingPreviews, { detailsName: "paycom.details.json" });
    expect(jobs).toHaveLength(3);
    const driver = jobs.find((j) => j.source_id === "53229");
    expect(driver?.title).toBe("Driver");
    expect(driver?.company).toBe("Portal Inc");
    expect(driver?.url).toBe(
      `https://www.paycomonline.net/v4/ats/web.php/jobs/ViewJobDetails?job=53229&clientkey=${CK_UPPER}`,
    );
    expect(driver?.location_text).toBe("GRAFTON, WI 53024");
    expect(driver?.department).toBe("Transportation");
    expect(driver?.posted_at).toBe("2026-04-02T00:00:00.000Z");
    expect(driver?.compensation_min).toBe(15);
    expect(driver?.compensation_max).toBeUndefined();
    expect(driver?.description_excerpt).toContain("responsible");
    expect(driver?.description_excerpt).not.toContain("<p>");

    // Remote role: workplace_type from detail.remoteType; ranged salary.
    const life = jobs.find((j) => j.source_id === "73957");
    expect(life?.workplace_type).toBe("remote");
    expect(life?.compensation_min).toBe(40000);
    expect(life?.compensation_max).toBe(52000);
    expect(new Set(jobs.map((j) => j.id)).size).toBe(jobs.length);
  });

  it("builds preview-only rows when no detail is supplied", () => {
    const jobs = parse(SMALL.jobPostingPreviews);
    expect(jobs).toHaveLength(3);
    const driver = jobs.find((j) => j.source_id === "53229");
    expect(driver?.location_text).toBeUndefined();
    expect(driver?.posted_at).toBeUndefined();
    expect(driver?.compensation_min).toBeUndefined();
    // Preview description still yields an excerpt.
    expect(driver?.description_excerpt).toContain("responsible");
  });

  it("handles the edge board: nulls, dupes, entities, blank title, bad date/pay", () => {
    const jobs = parse(EDGE.jobPostingPreviews, {
      slug: SLUG,
      company: "Edge Co",
      detailsName: "paycom.edge.details.json",
    });
    // 6 rows: null-id + blank-title dropped, dup id deduped → 3 jobs.
    expect(jobs).toHaveLength(3);

    const welder = jobs.find((j) => j.source_id === "9001");
    expect(welder?.title).toBe("Maintenance Tech & Welder"); // entity decoded
    expect(welder?.workplace_type).toBe("remote"); // detail.remoteType
    expect(welder?.location_text).toBeUndefined(); // null location + city
    expect(welder?.posted_at).toBeUndefined(); // future startDate dropped
    expect(welder?.compensation_min).toBeUndefined(); // inverted range dropped

    const sales = jobs.filter((j) => j.source_id === "9002");
    expect(sales).toHaveLength(1); // duplicate id deduped
    expect(sales[0]?.posted_at).toBe("2026-05-01T00:00:00.000Z"); // preview postedOn

    const recruiter = jobs.find((j) => j.source_id === "9004");
    expect(recruiter?.is_recruiter_post).toBe(true);
    expect(recruiter?.posted_at).toBeUndefined(); // future preview postedOn dropped
  });
});

describe("parsePaycomPreviews (property)", () => {
  it("is deterministic on identical input", () => {
    const details = detailsMap("paycom.edge.details.json");
    fc.assert(
      fc.property(fc.constantFrom(SLUG, "0d90fb4d87bb9b02d42f814bffce490f"), (slug) => {
        const a = parsePaycomPreviews({
          tenant: { slug },
          clientKeyUpper: slug.toUpperCase(),
          company: slug,
          previews: EDGE.jobPostingPreviews as never,
          observedAt: OBSERVED_AT,
          details,
        });
        const b = parsePaycomPreviews({
          tenant: { slug },
          clientKeyUpper: slug.toUpperCase(),
          company: slug,
          previews: EDGE.jobPostingPreviews as never,
          observedAt: OBSERVED_AT,
          details,
        });
        return JSON.stringify(a) === JSON.stringify(b);
      }),
      { numRuns: 15 },
    );
  });
});

describe("scrapePaycomTenant", () => {
  it("bootstraps the session, paginates search, fans out detail, returns success", async () => {
    serve({ detailsName: "paycom.details.json" });
    const out = await run({ slug: SLUG, display_name: "Portal Inc" });
    expect(out.result.status).toBe("success");
    expect(out.result.jobs_count).toBe(3);
    expect(out.result.http_status).toBe(200);
    expect(out.result.error).toBeUndefined();
    expect(out.jobs.every((j) => j.ats === "paycom")).toBe(true);
    const driver = out.jobs.find((j) => j.source_id === "53229");
    expect(driver?.location_text).toBe("GRAFTON, WI 53024");
    expect(driver?.compensation_min).toBe(15);
  });

  it("paginates when the count exceeds the page size", async () => {
    let pages = 0;
    server.use(
      http.get(CAREER_URL, () => new HttpResponse(PORTAL)),
      http.post(SEARCH_URL, async ({ request }) => {
        pages += 1;
        const { skip, take } = (await request.json()) as { skip: number; take: number };
        const all = SMALL.jobPostingPreviews;
        return HttpResponse.json({
          jobPostingPreviews: all.slice(skip, skip + take),
          jobPostingPreviewsCount: all.length,
        });
      }),
      http.get(DETAIL_URL, () => HttpResponse.json({ jobPosting: {} })),
    );
    const out = await run({ slug: SLUG }, { pageSize: 2 });
    // 3 roles, take=2 → page 1 (2 rows) + page 2 (1 row).
    expect(pages).toBe(2);
    expect(out.result.jobs_count).toBe(3);
  });

  it("caps the detail fan-out and reports a capped note", async () => {
    let detailHits = 0;
    server.use(
      http.get(CAREER_URL, () => new HttpResponse(PORTAL)),
      http.post(SEARCH_URL, () =>
        HttpResponse.json({
          jobPostingPreviews: SMALL.jobPostingPreviews,
          jobPostingPreviewsCount: SMALL.jobPostingPreviews.length,
        }),
      ),
      http.get(DETAIL_URL, () => {
        detailHits += 1;
        return HttpResponse.json({ jobPosting: {} });
      }),
    );
    const out = await run({ slug: SLUG }, { maxDetailFetch: 2 });
    // All 3 roles still emit (preview-only tail); only 2 detail GETs run.
    expect(out.result.jobs_count).toBe(3);
    expect(detailHits).toBe(2);
    expect(out.result.error).toBe("capped at 2 of 3 roles");
  });

  it("keeps the preview-only row when a detail GET fails", async () => {
    server.use(
      http.get(CAREER_URL, () => new HttpResponse(PORTAL)),
      http.post(SEARCH_URL, () =>
        HttpResponse.json({
          jobPostingPreviews: SMALL.jobPostingPreviews,
          jobPostingPreviewsCount: SMALL.jobPostingPreviews.length,
        }),
      ),
      http.get(DETAIL_URL, () => new HttpResponse("boom", { status: 500 })),
    );
    const out = await run({ slug: SLUG });
    expect(out.result.status).toBe("success");
    expect(out.result.jobs_count).toBe(3);
    expect(out.jobs.find((j) => j.source_id === "53229")?.location_text).toBeUndefined();
  });

  it("marks the tenant dead when the career page has no session", async () => {
    server.use(http.get(CAREER_URL, () => new HttpResponse(NOBOOT)));
    const out = await run({ slug: SLUG });
    expect(out.result.status).toBe("dead");
    expect(out.result.error).toContain("configsFromHost");
    expect(out.result.jobs_count).toBe(0);
  });

  it("marks the tenant dead when the API host is SSRF-rejected", async () => {
    server.use(http.get(CAREER_URL, () => new HttpResponse(SSRF)));
    const out = await run({ slug: SLUG });
    expect(out.result.status).toBe("dead");
    expect(out.result.error).toContain("SSRF-rejected");
  });

  it("marks the tenant dead when the session JWT is missing", async () => {
    server.use(http.get(CAREER_URL, () => new HttpResponse(NOJWT)));
    const out = await run({ slug: SLUG });
    expect(out.result.status).toBe("dead");
  });

  it("retries a 5xx on the career-page step then succeeds", async () => {
    let n = 0;
    server.use(
      http.get(CAREER_URL, () => {
        n += 1;
        return n < 2 ? new HttpResponse("err", { status: 503 }) : new HttpResponse(PORTAL);
      }),
      http.post(SEARCH_URL, () =>
        HttpResponse.json({ jobPostingPreviews: [], jobPostingPreviewsCount: 0 }),
      ),
    );
    const out = await run({ slug: SLUG });
    expect(n).toBe(2);
    expect(out.result.status).toBe("success");
  });

  it("retries a 5xx on the search step then succeeds", async () => {
    let n = 0;
    server.use(
      http.get(CAREER_URL, () => new HttpResponse(PORTAL)),
      http.post(SEARCH_URL, () => {
        n += 1;
        return n < 2
          ? new HttpResponse("err", { status: 503 })
          : HttpResponse.json({
              jobPostingPreviews: SMALL.jobPostingPreviews,
              jobPostingPreviewsCount: SMALL.jobPostingPreviews.length,
            });
      }),
      http.get(DETAIL_URL, () => HttpResponse.json({ jobPosting: {} })),
    );
    const out = await run({ slug: SLUG });
    expect(n).toBe(2);
    expect(out.result.status).toBe("success");
    expect(out.result.jobs_count).toBe(3);
  });

  it("marks dead on 404 and transient on exhausted 5xx at the career page", async () => {
    server.use(http.get(CAREER_URL, () => new HttpResponse("no", { status: 404 })));
    expect((await run({ slug: SLUG })).result.status).toBe("dead");
    server.resetHandlers();
    server.use(http.get(CAREER_URL, () => new HttpResponse("err", { status: 502 })));
    expect((await run({ slug: SLUG })).result.status).toBe("transient_failure");
  });

  it("marks the tenant transient on exhausted 5xx at the search step", async () => {
    server.use(
      http.get(CAREER_URL, () => new HttpResponse(PORTAL)),
      http.post(SEARCH_URL, () => new HttpResponse("err", { status: 502 })),
    );
    expect((await run({ slug: SLUG })).result.status).toBe("transient_failure");
  });

  it("blocks on robots.txt Disallow: / at the career page", async () => {
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
    const out = await scrapePaycomTenant({
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

  it("marks the tenant dead when the slug is not a 32-hex clientkey", async () => {
    const out = await run({ slug: "acme" });
    expect(out.result.status).toBe("dead");
    expect(out.result.error).toContain("32-hex clientkey");
  });
});
