import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from "bun:test";
import type { TenantInput } from "@openroles/shared";
import fc from "fast-check";
import {
  createWorkstreamPacer,
  parseWorkstreamBoardPage,
  parseWorkstreamJobPage,
  scrapeWorkstreamTenant,
  type WorkstreamPacer,
} from "../../src/ats/workstream.ts";
import { HttpClient } from "../../src/http.ts";
import { RobotsTxtCache } from "../../src/robots.ts";
import {
  clientWithRobotsAllowAll,
  HttpResponse,
  http,
  makeServer,
  readFixtureText,
} from "../helpers.ts";

const OBSERVED_AT = "2026-07-03T00:00:00Z";
const COMPANY_ID = "ab12cd34";
const SLUG = "acme-grill";
const BASE = `https://www.workstream.us/j/${COMPANY_ID}/${SLUG}`;
const BOARD_URL = `${BASE}/positions`;

const JOB_DISHWASHER = `${BASE}/austin-68686/dishwasher-acme-downtown-a726f5c8`;
const JOB_LINECOOK = `${BASE}/austin-68686/line-cook-prep-cook-acme-downtown-c8751e83`;
const JOB_SERVER = `${BASE}/dallas-68685/server-bartender-acme-north-87dd151d`;
const JOB_BARMANAGER = `${BASE}/dallas-68685/bar-manager-acme-north-df016e56`;
const JOB_SOUSCHEF = `${BASE}/dallas-68685/sous-chef-acme-north-1894119b`;

const PAGE1_HTML = readFixtureText("workstream.board.page1.html");
const PAGE2_HTML = readFixtureText("workstream.board.page2.html");
const EMPTY_HTML = readFixtureText("workstream.board.empty.html");
const DISHWASHER_HTML = readFixtureText("workstream.job.dishwasher.html");
const LINECOOK_HTML = readFixtureText("workstream.job.linecook.html");
const SERVER_HTML = readFixtureText("workstream.job.server.html");
const BARMANAGER_HTML = readFixtureText("workstream.job.barmanager.html");
const SOUSCHEF_HTML = readFixtureText("workstream.job.souschef.html");
const NO_JSONLD_HTML = readFixtureText("workstream.job.no-jsonld.html");

const server = makeServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function boardHandlers(): void {
  server.use(
    http.get(BOARD_URL, ({ request }) => {
      const page = new URL(request.url).searchParams.get("page");
      if (page === null) return new HttpResponse(PAGE1_HTML);
      if (page === "2") return new HttpResponse(PAGE2_HTML);
      return new HttpResponse(EMPTY_HTML);
    }),
    http.get(JOB_DISHWASHER, () => new HttpResponse(DISHWASHER_HTML)),
    http.get(JOB_LINECOOK, () => new HttpResponse(LINECOOK_HTML)),
    http.get(JOB_SERVER, () => new HttpResponse(SERVER_HTML)),
    http.get(JOB_BARMANAGER, () => new HttpResponse(BARMANAGER_HTML)),
    http.get(JOB_SOUSCHEF, () => new HttpResponse(SOUSCHEF_HTML)),
  );
}

function run(
  tenant: TenantInput,
  overrides: {
    companyId?: string;
    maxPages?: number;
    maxDetailFetches?: number;
    maxDegradedRefetches?: number;
    pacer?: WorkstreamPacer;
    sleepFn?: (ms: number) => Promise<void>;
  } = {},
): ReturnType<typeof scrapeWorkstreamTenant> {
  return scrapeWorkstreamTenant({
    tenant,
    client: clientWithRobotsAllowAll(),
    observedAt: OBSERVED_AT,
    companyId: overrides.companyId ?? COMPANY_ID,
    // Zero-delay pacer + zero degraded backoff (through the default sleeper)
    // so the paced fan-out replays instantly; individual tests inject a
    // fake-clock pacer / stub sleeper to observe the pacing calls.
    pacer: overrides.pacer ?? createWorkstreamPacer({ requestDelayMs: 0 }),
    degradedRetryDelayMs: 0,
    ...(overrides.sleepFn !== undefined ? { sleepFn: overrides.sleepFn } : {}),
    ...(overrides.maxDetailFetches !== undefined
      ? { maxDetailFetches: overrides.maxDetailFetches }
      : {}),
    ...(overrides.maxDegradedRefetches !== undefined
      ? { maxDegradedRefetches: overrides.maxDegradedRefetches }
      : {}),
    ...(overrides.maxPages !== undefined ? { maxPages: overrides.maxPages } : {}),
  });
}

describe("parseWorkstreamBoardPage (fixture replay)", () => {
  it("extracts tenant-anchored position links, deduped; ignores location, cross-tenant and malformed links", () => {
    const entries = parseWorkstreamBoardPage(PAGE1_HTML, COMPANY_ID, SLUG);
    expect(entries.map((e) => e.sourceId)).toEqual(["a726f5c8", "c8751e83", "87dd151d"]);
    // Canonical URL = query-stripped board link.
    expect(entries[0]?.url).toBe(JOB_DISHWASHER);
    expect(entries[2]?.url).toBe(JOB_SERVER);
    // The cross-tenant `deadbeef/other-restaurant` link is excluded.
    expect(entries.some((e) => e.sourceId === "11223344")).toBe(false);
  });

  it("extracts the last-page shape (fewer than a full page of links)", () => {
    const entries = parseWorkstreamBoardPage(PAGE2_HTML, COMPANY_ID, SLUG);
    expect(entries.map((e) => e.sourceId)).toEqual(["df016e56", "1894119b", "a726f5c8"]);
  });

  it("returns an empty list for a past-the-end page (edge)", () => {
    expect(parseWorkstreamBoardPage(EMPTY_HTML, COMPANY_ID, SLUG)).toEqual([]);
  });

  it("accepts relative /j/ links and drops query strings", () => {
    const html = `<a class="view-position-btn" href="/j/${COMPANY_ID}/${SLUG}/austin-1/cook-acme-0badcafe?locale=en&x=1">x</a>`;
    const [entry] = parseWorkstreamBoardPage(html, COMPANY_ID, SLUG);
    expect(entry?.sourceId).toBe("0badcafe");
    expect(entry?.url).toBe(`${BASE}/austin-1/cook-acme-0badcafe`);
  });
});

describe("parseWorkstreamJobPage (fixture replay)", () => {
  it("builds a Job from the page's JobPosting JSON-LD", () => {
    const job = parseWorkstreamJobPage({
      tenant: { slug: SLUG, display_name: "Acme Grill" },
      company: "Acme Grill",
      url: JOB_DISHWASHER,
      sourceId: "a726f5c8",
      html: DISHWASHER_HTML,
      observedAt: OBSERVED_AT,
    });
    expect(job).not.toBeNull();
    expect(job?.title).toBe("Dishwasher - Acme Downtown");
    expect(job?.source_id).toBe("a726f5c8");
    expect(job?.url).toBe(JOB_DISHWASHER);
    expect(job?.company).toBe("Acme Grill");
    expect(job?.location_text).toBe("Austin, TX, US");
    expect(job?.location_country).toBe("US");
    expect(job?.location_region).toBe("TX");
    expect(job?.posted_at).toBe("2026-06-12T00:00:00Z");
    expect(job?.description_excerpt).toContain("Keep our kitchen humming");
    expect(job?.description_excerpt).not.toContain("<p>");
  });

  it("decodes HTML entities in the title (edge)", () => {
    const job = parseWorkstreamJobPage({
      tenant: { slug: SLUG },
      company: "Acme Grill",
      url: JOB_SERVER,
      sourceId: "87dd151d",
      html: SERVER_HTML,
      observedAt: OBSERVED_AT,
    });
    expect(job?.title).toBe("Server & Bartender - Acme North");
    expect(job?.description_excerpt).toContain("floor & behind the bar");
  });

  it("drops a future datePosted rather than failing the row (edge)", () => {
    const job = parseWorkstreamJobPage({
      tenant: { slug: SLUG },
      company: "Acme Grill",
      url: JOB_LINECOOK,
      sourceId: "c8751e83",
      html: LINECOOK_HTML,
      observedAt: OBSERVED_AT,
    });
    expect(job).not.toBeNull();
    expect(job?.posted_at).toBeUndefined();
  });

  it("returns null when the page carries no JobPosting JSON-LD (edge)", () => {
    const job = parseWorkstreamJobPage({
      tenant: { slug: SLUG },
      company: "Acme Grill",
      url: JOB_DISHWASHER,
      sourceId: "a726f5c8",
      html: NO_JSONLD_HTML,
      observedAt: OBSERVED_AT,
    });
    expect(job).toBeNull();
  });
});

describe("workstream parsers (property)", () => {
  it("board + job-page parsing are deterministic on identical input", () => {
    fc.assert(
      fc.property(fc.constantFrom("acme-grill", "globex-diner", "initech-cafe"), (slug) => {
        const html = `<a href="https://www.workstream.us/j/${COMPANY_ID}/${slug}/austin-1/cook-${slug}-0badcafe">x</a>`;
        const a = parseWorkstreamBoardPage(html, COMPANY_ID, slug);
        const b = parseWorkstreamBoardPage(html, COMPANY_ID, slug);
        const pa = parseWorkstreamJobPage({
          tenant: { slug },
          company: slug,
          url: a[0]?.url ?? "",
          sourceId: "0badcafe",
          html: DISHWASHER_HTML,
          observedAt: OBSERVED_AT,
        });
        const pb = parseWorkstreamJobPage({
          tenant: { slug },
          company: slug,
          url: b[0]?.url ?? "",
          sourceId: "0badcafe",
          html: DISHWASHER_HTML,
          observedAt: OBSERVED_AT,
        });
        return JSON.stringify(a) === JSON.stringify(b) && JSON.stringify(pa) === JSON.stringify(pb);
      }),
      { numRuns: 20 },
    );
  });
});

describe("scrapeWorkstreamTenant", () => {
  it("walks board pages until an empty page, dedupes across pages, and assembles Jobs", async () => {
    boardHandlers();
    const out = await run({ slug: SLUG, display_name: "Acme Grill" });
    expect(out.result.status).toBe("success");
    // 3 unique roles on page 1 + 2 new on page 2; the cross-page repeat of
    // a726f5c8 collapses to a single row.
    expect(out.result.jobs_count).toBe(5);
    expect(out.result.http_status).toBe(200);
    const urls = out.jobs.map((j) => j.url).sort();
    expect(urls).toEqual(
      [JOB_DISHWASHER, JOB_LINECOOK, JOB_SERVER, JOB_BARMANAGER, JOB_SOUSCHEF].sort(),
    );
    expect(new Set(out.jobs.map((j) => j.id)).size).toBe(5);
  });

  it("serializes the N+1 fan-out through the pacer (never two requests in flight)", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const tracked = (html: string) => async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return new HttpResponse(html);
    };
    server.use(
      http.get(BOARD_URL, async ({ request }) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
        const page = new URL(request.url).searchParams.get("page");
        if (page === null) return new HttpResponse(PAGE1_HTML);
        if (page === "2") return new HttpResponse(PAGE2_HTML);
        return new HttpResponse(EMPTY_HTML);
      }),
      http.get(JOB_DISHWASHER, tracked(DISHWASHER_HTML)),
      http.get(JOB_LINECOOK, tracked(LINECOOK_HTML)),
      http.get(JOB_SERVER, tracked(SERVER_HTML)),
      http.get(JOB_BARMANAGER, tracked(BARMANAGER_HTML)),
      http.get(JOB_SOUSCHEF, tracked(SOUSCHEF_HTML)),
    );
    const out = await run({ slug: SLUG });
    expect(out.result.jobs_count).toBe(5);
    expect(maxInFlight).toBe(1);
  });

  it("shares one pacer across concurrent tenant scrapes: serialized and spaced at the host", async () => {
    // The rate limit is per-IP at www.workstream.us, so two tenants scraped
    // concurrently must interleave through the SAME pacer — no two requests
    // in flight at once and >= requestDelayMs between consecutive requests,
    // verified with a fake clock (no real sleeping).
    const CID2 = "ffee0011";
    const SLUG2 = "globex-diner";
    const BASE2 = `https://www.workstream.us/j/${CID2}/${SLUG2}`;
    const JOB2 = `${BASE2}/austin-1/cook-globex-0badcafe`;
    const board2 = `<a class="view-position-btn" href="${JOB2}?locale=en">x</a>`;

    let clockMs = 0;
    const pacerSleeps: number[] = [];
    const pacer = createWorkstreamPacer({
      requestDelayMs: 1_000,
      now: () => clockMs,
      sleepFn: async (ms) => {
        pacerSleeps.push(ms);
        clockMs += ms;
      },
    });

    let inFlight = 0;
    let maxInFlight = 0;
    let totalRequests = 0;
    const tracked =
      (body: (url: string) => string) =>
      async ({ request }: { request: Request }) => {
        inFlight += 1;
        totalRequests += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 2));
        inFlight -= 1;
        return new HttpResponse(body(request.url));
      };
    server.use(
      http.get(
        BOARD_URL,
        tracked((url) =>
          new URL(url).searchParams.get("page") === null ? PAGE2_HTML : EMPTY_HTML,
        ),
      ),
      http.get(
        JOB_DISHWASHER,
        tracked(() => DISHWASHER_HTML),
      ),
      http.get(
        JOB_BARMANAGER,
        tracked(() => BARMANAGER_HTML),
      ),
      http.get(
        JOB_SOUSCHEF,
        tracked(() => SOUSCHEF_HTML),
      ),
      http.get(
        `${BASE2}/positions`,
        tracked((url) => (new URL(url).searchParams.get("page") === null ? board2 : EMPTY_HTML)),
      ),
      http.get(
        JOB2,
        tracked(() => DISHWASHER_HTML),
      ),
    );

    const [a, b] = await Promise.all([
      run({ slug: SLUG }, { pacer }),
      run({ slug: SLUG2 }, { pacer, companyId: CID2 }),
    ]);
    expect(a.result.status).toBe("success");
    expect(a.result.jobs_count).toBe(3);
    expect(b.result.status).toBe("success");
    expect(b.result.jobs_count).toBe(1);
    // Never two requests to the host at once, across BOTH tenants.
    expect(maxInFlight).toBe(1);
    // Every request after the first waited out the full spacing gap.
    expect(totalRequests).toBe(8);
    expect(pacerSleeps).toHaveLength(totalRequests - 1);
    expect(pacerSleeps.every((ms) => ms === 1_000)).toBe(true);
  });

  it("caps tenant-wide degraded re-fetches and surfaces the shortfall (C-2 budget)", async () => {
    // barmanager recovers on its one budgeted re-fetch; souschef stays
    // degraded but the tenant budget is spent, so it fails immediately and
    // the error notes the exhausted budget.
    let barmanagerFetches = 0;
    let sousChefFetches = 0;
    boardHandlers();
    server.use(
      http.get(JOB_BARMANAGER, () => {
        barmanagerFetches += 1;
        return new HttpResponse(barmanagerFetches === 1 ? NO_JSONLD_HTML : BARMANAGER_HTML);
      }),
      http.get(JOB_SOUSCHEF, () => {
        sousChefFetches += 1;
        return new HttpResponse(NO_JSONLD_HTML);
      }),
    );
    const out = await run({ slug: SLUG }, { maxDegradedRefetches: 1 });
    expect(barmanagerFetches).toBe(2);
    expect(sousChefFetches).toBe(1);
    expect(out.result.status).toBe("success");
    expect(out.result.jobs_count).toBe(4);
    expect(out.result.error).toBe(
      "1/5 job pages failed to parse JSON-LD (degraded re-fetch budget exhausted)",
    );
  });

  it("surfaces detail-cap truncation instead of reporting a clean success (M-1)", async () => {
    server.use(
      http.get(BOARD_URL, ({ request }) => {
        const page = new URL(request.url).searchParams.get("page");
        return new HttpResponse(page === null ? PAGE1_HTML : EMPTY_HTML);
      }),
      http.get(JOB_DISHWASHER, () => new HttpResponse(DISHWASHER_HTML)),
      http.get(JOB_LINECOOK, () => new HttpResponse(LINECOOK_HTML)),
    );
    const out = await run({ slug: SLUG }, { maxDetailFetches: 2 });
    expect(out.result.status).toBe("success");
    expect(out.result.jobs_count).toBe(2);
    expect(out.result.error).toBe("capped at 2 of 3 discovered roles");
  });

  it("stops the walk at the page cap", async () => {
    let boardFetches = 0;
    server.use(
      http.get(BOARD_URL, () => {
        boardFetches += 1;
        return new HttpResponse(PAGE1_HTML);
      }),
      http.get(JOB_DISHWASHER, () => new HttpResponse(DISHWASHER_HTML)),
      http.get(JOB_LINECOOK, () => new HttpResponse(LINECOOK_HTML)),
      http.get(JOB_SERVER, () => new HttpResponse(SERVER_HTML)),
    );
    const out = await run({ slug: SLUG }, { maxPages: 1 });
    expect(boardFetches).toBe(1);
    expect(out.result.status).toBe("success");
    expect(out.result.jobs_count).toBe(3);
  });

  it("re-fetches a degraded 200 (JSON-LD stripped by the rate limit) after a backoff sleep", async () => {
    // www.workstream.us keeps answering 200 under its soft rate limit but
    // drops the JSON-LD block; the adapter must sleep the recovery delay and
    // re-fetch instead of losing the role.
    let sousChefFetches = 0;
    const pacerSleeps: number[] = [];
    const backoffSleeps: number[] = [];
    let clockMs = 0;
    boardHandlers();
    server.use(
      http.get(JOB_SOUSCHEF, () => {
        sousChefFetches += 1;
        return new HttpResponse(sousChefFetches === 1 ? NO_JSONLD_HTML : SOUSCHEF_HTML);
      }),
    );
    const out = await scrapeWorkstreamTenant({
      tenant: { slug: SLUG },
      client: clientWithRobotsAllowAll(),
      observedAt: OBSERVED_AT,
      companyId: COMPANY_ID,
      pacer: createWorkstreamPacer({
        requestDelayMs: 3,
        now: () => clockMs,
        sleepFn: async (ms) => {
          pacerSleeps.push(ms);
          clockMs += ms;
        },
      }),
      degradedRetryDelayMs: 7,
      sleepFn: async (ms) => {
        backoffSleeps.push(ms);
      },
    });
    expect(sousChefFetches).toBe(2);
    expect(out.result.status).toBe("success");
    expect(out.result.jobs_count).toBe(5);
    expect(out.result.error).toBeUndefined();
    // The degraded re-fetch waited the recovery backoff; every request after
    // the first waited the pacer's inter-request gap.
    expect(backoffSleeps).toEqual([7]);
    expect(pacerSleeps.every((ms) => ms === 3)).toBe(true);
    expect(pacerSleeps.length).toBeGreaterThan(0);
  });

  it("skips job pages with no JobPosting and reports the failure count", async () => {
    boardHandlers();
    server.use(http.get(JOB_SOUSCHEF, () => new HttpResponse(NO_JSONLD_HTML)));
    const out = await run({ slug: SLUG });
    expect(out.result.status).toBe("success");
    expect(out.result.jobs_count).toBe(4);
    expect(out.result.error).toContain("1/5 job pages failed");
  });

  it("reports transient_failure when more than half the job pages yield no JobPosting", async () => {
    boardHandlers();
    server.use(
      http.get(JOB_DISHWASHER, () => new HttpResponse(NO_JSONLD_HTML)),
      http.get(JOB_LINECOOK, () => new HttpResponse(NO_JSONLD_HTML)),
      http.get(JOB_SERVER, () => new HttpResponse(NO_JSONLD_HTML)),
      http.get(JOB_BARMANAGER, () => new HttpResponse(NO_JSONLD_HTML)),
    );
    const out = await run({ slug: SLUG });
    expect(out.result.status).toBe("transient_failure");
    expect(out.result.jobs_count).toBe(1);
  });

  it("treats a non-2xx job page as a skipped role, not a tenant failure", async () => {
    boardHandlers();
    server.use(http.get(JOB_BARMANAGER, () => new HttpResponse("boom", { status: 500 })));
    const out = await run({ slug: SLUG });
    expect(out.result.status).toBe("success");
    expect(out.result.jobs_count).toBe(4);
  });

  it("returns success with zero jobs for an empty board", async () => {
    server.use(http.get(BOARD_URL, () => new HttpResponse(EMPTY_HTML)));
    const out = await run({ slug: SLUG });
    expect(out.result.status).toBe("success");
    expect(out.result.jobs_count).toBe(0);
  });

  it("retries the board on 5xx then succeeds", async () => {
    let attempts = 0;
    server.use(
      http.get(BOARD_URL, ({ request }) => {
        const page = new URL(request.url).searchParams.get("page");
        if (page === null) {
          attempts += 1;
          if (attempts < 2) return new HttpResponse("err", { status: 503 });
          return new HttpResponse(PAGE2_HTML);
        }
        return new HttpResponse(EMPTY_HTML);
      }),
      http.get(JOB_DISHWASHER, () => new HttpResponse(DISHWASHER_HTML)),
      http.get(JOB_BARMANAGER, () => new HttpResponse(BARMANAGER_HTML)),
      http.get(JOB_SOUSCHEF, () => new HttpResponse(SOUSCHEF_HTML)),
    );
    const out = await run({ slug: SLUG });
    expect(attempts).toBe(2);
    expect(out.result.status).toBe("success");
    expect(out.result.jobs_count).toBe(3);
  });

  it("marks the tenant dead when the board answers 410 (decommissioned tenant)", async () => {
    // A dead/unknown (companyId, slug) pair answers HTTP 410 Gone.
    server.use(http.get(BOARD_URL, () => new HttpResponse("gone", { status: 410 })));
    const out = await run({ slug: SLUG });
    expect(out.result.status).toBe("dead");
    expect(out.result.http_status).toBe(410);
    expect(out.jobs).toHaveLength(0);
  });

  it("marks the tenant dead when the board 404s", async () => {
    server.use(http.get(BOARD_URL, () => new HttpResponse("nope", { status: 404 })));
    const out = await run({ slug: SLUG });
    expect(out.result.status).toBe("dead");
    expect(out.result.http_status).toBe(404);
  });

  it("marks the tenant transient_failure on exhausted board retries", async () => {
    server.use(http.get(BOARD_URL, () => new HttpResponse("err", { status: 502 })));
    const out = await run({ slug: SLUG });
    expect(out.result.status).toBe("transient_failure");
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
    const out = await scrapeWorkstreamTenant({
      tenant: { slug: SLUG },
      client,
      observedAt: OBSERVED_AT,
      companyId: COMPANY_ID,
      pacer: createWorkstreamPacer({ requestDelayMs: 0 }),
      degradedRetryDelayMs: 0,
    });
    expect(out.result.status).toBe("dead");
    expect(out.result.error).toContain("robots.txt");
  });

  it("marks the tenant dead on an unsafe slug", async () => {
    const out = await run({ slug: "Bad_Slug" });
    expect(out.result.status).toBe("dead");
    expect(out.result.error).toContain("tenant slug rejected");
  });

  it("marks the tenant dead on a malformed company id (no request made)", async () => {
    for (const bad of ["DEADBEEF", "a468d09", "a468d0922", "../../etc", "zzzzzzzz"]) {
      const out = await run({ slug: SLUG }, { companyId: bad });
      expect(out.result.status).toBe("dead");
      expect(out.result.error).toContain("company id rejected");
    }
  });
});
