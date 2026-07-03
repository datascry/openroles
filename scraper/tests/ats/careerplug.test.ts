import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from "bun:test";
import type { TenantInput } from "@openroles/shared";
import fc from "fast-check";
import {
  careerplugLastPage,
  parseCareerplugListing,
  scrapeCareerplugTenant,
} from "../../src/ats/careerplug.ts";
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
const SLUG = "acme";
const LISTING_URL = `https://${SLUG}.careerplug.com/jobs`;
const LISTING = readFixtureText("careerplug.listing.html");
const PAGE2 = readFixtureText("careerplug.page2.html");
const EMPTY = readFixtureText("careerplug.empty.html");
const EDGE = readFixtureText("careerplug.edge.html");
const WINDOWED = readFixtureText("careerplug.windowed.html");

const server = makeServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function parse(html: string, tenant: TenantInput = { slug: SLUG, display_name: "Acme Fitness" }) {
  return parseCareerplugListing({
    tenant,
    company: tenant.display_name ?? tenant.slug,
    html,
    observedAt: OBSERVED_AT,
  });
}

function run(
  tenant: TenantInput,
  opts: { maxPages?: number } = {},
): ReturnType<typeof scrapeCareerplugTenant> {
  return scrapeCareerplugTenant({
    tenant,
    client: clientWithRobotsAllowAll(),
    observedAt: OBSERVED_AT,
    ...(opts.maxPages !== undefined ? { maxPages: opts.maxPages } : {}),
  });
}

// Serve the two-page board: /jobs → page 1 (nav shows 2 pages), /jobs?page=2 → page 2.
function servePagedBoard(): { requests: string[] } {
  const requests: string[] = [];
  server.use(
    http.get(LISTING_URL, ({ request }) => {
      requests.push(request.url);
      const page = new URL(request.url).searchParams.get("page");
      return new HttpResponse(page === "2" ? PAGE2 : LISTING);
    }),
  );
  return { requests };
}

// A minimal but real-shaped listing page for a variant renderer whose nav
// window omits the tail numbered link: the nav announces only the pages it
// windows, and only the live `next_page` anchor betrays that more follow.
function windowedNoTailPage(current: number, total: number, cardIds: number[]): string {
  const cards = cardIds
    .map(
      (id) =>
        `<div style="background-color: #762b85;"><a aria-label="Role ${id}" href="/jobs/${id}">` +
        `<div class="row"><div class="job-title col-sm-7" style="color: #762b85;">` +
        `<span class="name">Role ${id}</span></div></div></a></div>`,
    )
    .join("");
  const prev =
    current > 1
      ? `<a class="previous_page" rel="prev" href="/jobs?page=${current - 1}">previous</a>`
      : `<span class="previous_page disabled" aria-disabled="true">previous</span>`;
  const next =
    current < total
      ? `<a class="next_page" rel="next" href="/jobs?page=${current + 1}">next</a>`
      : `<span class="next_page disabled" aria-disabled="true">next</span>`;
  // Numbered window: only pages up to `current` — no tail link to `total`.
  const numbers = Array.from({ length: current }, (_, i) => {
    const n = i + 1;
    return n === current
      ? `<em class="current" aria-label="Go to page: ${n}" aria-current="page">${n}</em>`
      : `<a aria-label="Go to page: ${n}" href="/jobs?page=${n}">${n}</a>`;
  }).join(" ");
  return (
    `<!DOCTYPE html><html lang="en"><body><div><div id="job_table">${cards}</div>` +
    `<div class="job_pager"><div role="navigation" aria-label="Pagination" class="pagination">` +
    `${prev} ${numbers} ${next}</div></div></div></body></html>`
  );
}

// Serve a three-page board whose nav windows never announce the last page.
function serveNoTailBoard(): { requests: string[] } {
  const requests: string[] = [];
  const pages: Record<string, string> = {
    "1": windowedNoTailPage(1, 3, [101, 102]),
    "2": windowedNoTailPage(2, 3, [201]),
    "3": windowedNoTailPage(3, 3, [301]),
  };
  server.use(
    http.get(LISTING_URL, ({ request }) => {
      requests.push(request.url);
      const page = new URL(request.url).searchParams.get("page") ?? "1";
      return new HttpResponse(pages[page] ?? "");
    }),
  );
  return { requests };
}

describe("parseCareerplugListing (fixture replay)", () => {
  it("parses listing cards into validated, deep-linked Jobs", () => {
    const jobs = parse(LISTING);
    expect(jobs).toHaveLength(3);

    const mgr = jobs.find((j) => j.title === "Assistant Club Manager");
    expect(mgr?.source_id).toBe("1784845");
    expect(mgr?.url).toBe(`https://${SLUG}.careerplug.com/jobs/1784845`);
    expect(mgr?.company).toBe("Acme Fitness");
    // ST-City-ZIP card text is normalized to "City, ST".
    expect(mgr?.location_text).toBe("South Burlington, VT");
    expect(mgr?.location_region).toBe("VT");
    expect(mgr?.posted_at).toBe("2026-06-15T00:00:00.000Z");

    // A hyphenated city survives the ST-City-ZIP split.
    const remote = jobs.find((j) => j.title === "Remote Member Services Representative");
    expect(remote?.location_text).toBe("Wilkes-Barre, PA");
    expect(remote?.workplace_type).toBe("remote"); // inferred from title

    expect(new Set(jobs.map((j) => j.id)).size).toBe(jobs.length);
  });

  it("returns no jobs for an empty board", () => {
    expect(parse(EMPTY)).toHaveLength(0);
  });

  it("degrades gracefully on edge-case cards", () => {
    const jobs = parse(EDGE);
    // 9001 (entity title), 9002 (nested markup), 9005, 9006 — the duplicate
    // 9001 card is deduped, the id-less card and the titleless 9004 skipped.
    expect(jobs).toHaveLength(4);

    // HTML entities decoded; padded city trimmed before the ", ST" join.
    const desk = jobs.find((j) => j.source_id === "9001");
    expect(desk?.title).toBe("Front Desk & Sales Associate");
    expect(desk?.location_text).toBe("Round Rock, TX");
    expect(desk?.posted_at).toBe("2026-06-20T00:00:00.000Z");

    // Nested markup in the title span is stripped; missing location and
    // post-date columns are simply omitted rather than guessed.
    const gm = jobs.find((j) => j.source_id === "9002");
    expect(gm?.title).toBe("Senior General Manager");
    expect(gm?.location_text).toBeUndefined();
    expect(gm?.posted_at).toBeUndefined();

    // Non-ST-City-ZIP location text is kept verbatim; a post date in the
    // future of the observation is dropped (posted_at <= last_seen_at).
    const studio = jobs.find((j) => j.source_id === "9005");
    expect(studio?.location_text).toBe("Downtown Studio");
    expect(studio?.posted_at).toBeUndefined();

    // Whitespace-only location cell and an unparseable date are omitted.
    const regional = jobs.find((j) => j.source_id === "9006");
    expect(regional?.title).toBe("Regional Manager");
    expect(regional?.location_text).toBeUndefined();
    expect(regional?.posted_at).toBeUndefined();

    expect(jobs.some((j) => j.source_id === "9004")).toBe(false);
    expect(new Set(jobs.map((j) => j.id)).size).toBe(jobs.length);
  });
});

describe("parseCareerplugListing (property)", () => {
  it("is deterministic on identical input", () => {
    fc.assert(
      fc.property(fc.constantFrom("acme", "globex", "initech"), (slug) => {
        const a = parse(LISTING, { slug });
        const b = parse(LISTING, { slug });
        return JSON.stringify(a) === JSON.stringify(b);
      }),
      { numRuns: 15 },
    );
  });
});

describe("careerplugLastPage", () => {
  it("reads the last page number from the pagination nav", () => {
    expect(careerplugLastPage(LISTING)).toBe(2);
    expect(careerplugLastPage(PAGE2)).toBe(2);
  });

  it("treats a board without a pagination nav as a single page", () => {
    expect(careerplugLastPage(EMPTY)).toBe(1);
    expect(careerplugLastPage(EDGE)).toBe(1);
  });

  it("reads the tail link of a windowed nav on a large board", () => {
    // A 113-page board windows the nav (1..9, gap, 112, 113) but always
    // renders the last-page links after the gap ellipsis.
    expect(careerplugLastPage(WINDOWED)).toBe(113);
  });
});

describe("scrapeCareerplugTenant", () => {
  it("walks every page the pagination nav announces", async () => {
    const { requests } = servePagedBoard();
    const out = await run({ slug: SLUG, display_name: "Acme Fitness" });
    expect(out.result.status).toBe("success");
    expect(out.result.jobs_count).toBe(5); // 3 on page 1 + 2 on page 2
    expect(out.result.http_status).toBe(200);
    expect(requests).toHaveLength(2);
    expect(requests[1]).toContain("page=2");
    expect(out.jobs.every((j) => j.url.startsWith(`https://${SLUG}.careerplug.com/jobs/`))).toBe(
      true,
    );
  });

  it("fetches a single-page board exactly once", async () => {
    let n = 0;
    server.use(
      http.get(LISTING_URL, () => {
        n += 1;
        return new HttpResponse(EDGE); // no pagination nav → one page
      }),
    );
    const out = await run({ slug: SLUG });
    expect(out.result.status).toBe("success");
    expect(out.result.jobs_count).toBe(4);
    expect(n).toBe(1);
  });

  it("follows live next_page links past a nav window that omits the last page", async () => {
    // Pages 1..3 exist but every nav window stops at the current page — the
    // announced max undercounts, and only the live next link reveals page 3.
    const { requests } = serveNoTailBoard();
    const out = await run({ slug: SLUG });
    expect(out.result.status).toBe("success");
    expect(out.result.jobs_count).toBe(4); // 101, 102, 201, 301
    expect(out.result.error).toBeUndefined(); // walked to the end — no truncation
    expect(requests).toHaveLength(3);
    expect(requests[2]).toContain("page=3");
    expect(out.jobs.map((j) => j.source_id).sort()).toEqual(["101", "102", "201", "301"]);
  });

  it("reports truncation when the cap halts the walk with a live next link remaining", async () => {
    const { requests } = serveNoTailBoard();
    const out = await run({ slug: SLUG }, { maxPages: 2 });
    expect(out.result.status).toBe("success");
    expect(out.result.jobs_count).toBe(3); // page 3 never fetched
    expect(out.result.error).toContain("capped");
    expect(requests).toHaveLength(2);
  });

  it("stops at the page cap and reports the truncation", async () => {
    const { requests } = servePagedBoard();
    const out = await run({ slug: SLUG }, { maxPages: 1 });
    expect(out.result.status).toBe("success");
    expect(out.result.jobs_count).toBe(3); // page 2 never fetched
    expect(out.result.error).toContain("capped");
    expect(requests).toHaveLength(1);
  });

  it("returns success with zero jobs for an empty board", async () => {
    server.use(http.get(LISTING_URL, () => new HttpResponse(EMPTY)));
    const out = await run({ slug: SLUG });
    expect(out.result.status).toBe("success");
    expect(out.result.jobs_count).toBe(0);
  });

  it("retries on 5xx then succeeds", async () => {
    let n = 0;
    server.use(
      http.get(LISTING_URL, () => {
        n += 1;
        return n < 2 ? new HttpResponse("err", { status: 503 }) : new HttpResponse(EDGE);
      }),
    );
    const out = await run({ slug: SLUG });
    expect(n).toBe(2);
    expect(out.result.status).toBe("success");
  });

  it("marks dead on 404 and transient on exhausted 5xx", async () => {
    server.use(http.get(LISTING_URL, () => new HttpResponse("no", { status: 404 })));
    expect((await run({ slug: SLUG })).result.status).toBe("dead");
    server.resetHandlers();
    server.use(http.get(LISTING_URL, () => new HttpResponse("err", { status: 502 })));
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
    const out = await scrapeCareerplugTenant({
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
