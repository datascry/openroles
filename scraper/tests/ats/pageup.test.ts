import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from "bun:test";
import type { TenantInput } from "@openroles/shared";
import fc from "fast-check";
import { parsePageupListing, scrapePageupTenant } from "../../src/ats/pageup.ts";
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
const HOST = "careers.pageuppeople.com";
const INSTANCE = "438";
const CLIENTKEY = "caw";
const SLUG = "438-caw";
const LISTING_URL = `https://${HOST}/${INSTANCE}/${CLIENTKEY}/en/listing/`;

const CLASSIC_P1 = readFixtureText("pageup.classic.page1.html");
const CLASSIC_P2 = readFixtureText("pageup.classic.page2.html");
const CURRENT_P1 = readFixtureText("pageup.current.page1.html");
const EMPTY = readFixtureText("pageup.empty.html");
const EDGE = readFixtureText("pageup.edge.html");
const TRAILING_LOCATION = readFixtureText("pageup.trailing-location.html");

const server = makeServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function baseTenant(overrides: Partial<TenantInput> = {}): TenantInput {
  return { slug: SLUG, display_name: "Just Group", ...overrides };
}

function run(
  tenant: TenantInput = baseTenant(),
  opts: { maxPages?: number; host?: string; instance?: string; clientKey?: string } = {},
): ReturnType<typeof scrapePageupTenant> {
  return scrapePageupTenant({
    tenant,
    client: clientWithRobotsAllowAll(),
    observedAt: OBSERVED_AT,
    host: opts.host ?? HOST,
    instance: opts.instance ?? INSTANCE,
    clientKey: opts.clientKey ?? CLIENTKEY,
    ...(opts.maxPages !== undefined ? { maxPages: opts.maxPages } : {}),
  });
}

// Build a listing page of `count` distinct rows starting at `startId`, sized
// so the walk's short-page early stop only fires when count < PAGE_SIZE (15).
function pageOf(startId: number, count: number): string {
  const rows = Array.from({ length: count }, (_, i) => {
    const id = startId + i;
    return (
      `<li class="joblisting"><h3><a class="job-link" ` +
      `href="/${INSTANCE}/${CLIENTKEY}/en/job/${id}/role-${id}">Role ${id}</a></h3>` +
      `<span class="location">City ${id}</span></li>`
    );
  }).join("");
  return `<!DOCTYPE html><html lang="en"><body><ul id="search-results-content">${rows}</ul></body></html>`;
}

describe("parsePageupListing (fixture replay)", () => {
  it("parses the classic template into rows with title, id, slug and location", () => {
    const rows = parsePageupListing(CLASSIC_P1);
    expect(rows).toHaveLength(3);

    const coord = rows.find((r) => r.id === "945128");
    expect(coord?.title).toBe("Senior Product Coordinator - Just Jeans");
    expect(coord?.slug).toBe("senior-product-coordinator-just-jeans");
    expect(coord?.location).toBe("Various Locations");

    // Entity in the title survives as a single "&" (decoded before plainText).
    const pr = rows.find((r) => r.id === "945036");
    expect(pr?.title).toBe("PR Specialist R&D");
    expect(pr?.location).toBe("Melbourne, VIC");

    // Nested markup in the title is flattened; a row with no location cell
    // omits it rather than borrowing a neighbour's.
    const sell = rows.find((r) => r.id === "945211");
    expect(sell?.title).toBe("Service Selling Team Member");
    expect(sell?.location).toBeUndefined();
  });

  it("keys the current template on the job id, ignoring the 'See Details' duplicate anchor", () => {
    const rows = parsePageupListing(CURRENT_P1);
    // Two jobs, each rendered as a title anchor + a See Details anchor to the
    // same href — collapsed to one row apiece keyed on the id.
    expect(rows).toHaveLength(2);
    const chef = rows.find((r) => r.id === "721024");
    expect(chef?.title).toBe("Supervisor - Chef");
    expect(chef?.location).toBe("Perth");
    const head = rows.find((r) => r.id === "721048");
    expect(head?.title).toBe("VIC | Executive Head Chef");
    expect(head?.location).toBe("Multiple locations");
  });

  it("parses a subsequent listing page", () => {
    const rows = parsePageupListing(CLASSIC_P2);
    expect(rows.map((r) => r.id).sort()).toEqual(["944734", "945209"]);
    expect(rows.find((r) => r.id === "944734")?.location).toBe("Sydney, NSW");
  });

  it("does not let the last row borrow a location span from trailing non-row markup", () => {
    const rows = parsePageupListing(TRAILING_LOCATION);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id === "8001")?.location).toBe("Perth");
    // The last row has no location cell; a "suggested roles" widget after the
    // listing carries its own location span, which must not be borrowed.
    expect(rows.find((r) => r.id === "8002")?.location).toBeUndefined();
  });

  it("does not borrow a footer location when the last row is missing its </li>", () => {
    const rows = parsePageupListing(readFixtureText("pageup.trailing-location-malformed.html"));
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id === "8001")?.location).toBe("Perth");
    // The last row has no `</li>` at all; the scan is capped at `</ul>` (and a
    // fixed window), so the trailing "suggested roles" span is not borrowed.
    expect(rows.find((r) => r.id === "8002")?.location).toBeUndefined();
  });

  it("returns no rows for an empty board", () => {
    expect(parsePageupListing(EMPTY)).toHaveLength(0);
  });

  it("degrades gracefully on edge-case rows", () => {
    const rows = parsePageupListing(EDGE);
    // 9001 (entity + See Details dup), 9002 (nested, no loc), 9003 (label
    // anchor first, title anchor second). 9004 (empty title) is skipped.
    expect(rows).toHaveLength(3);

    const desk = rows.find((r) => r.id === "9001");
    expect(desk?.title).toBe("Front Desk & Sales Associate");
    expect(desk?.location).toBe("Round Rock, TX");

    const gm = rows.find((r) => r.id === "9002");
    expect(gm?.title).toBe("Senior General Manager");
    expect(gm?.location).toBeUndefined();

    // The label ("See Details") anchor precedes the title anchor, so the row
    // is seeded from the later title anchor; the location that sat before the
    // title anchor is not back-scanned and is simply omitted.
    const wh = rows.find((r) => r.id === "9003");
    expect(wh?.title).toBe("Warehouse Lead");
    expect(wh?.location).toBeUndefined();

    expect(rows.some((r) => r.id === "9004")).toBe(false);
  });
});

describe("parsePageupListing (property)", () => {
  it("is deterministic on identical input", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(CLASSIC_P1, CURRENT_P1, EDGE, EMPTY, TRAILING_LOCATION),
        (html) => {
          const a = JSON.stringify(parsePageupListing(html));
          const b = JSON.stringify(parsePageupListing(`${html}`));
          return a === b;
        },
      ),
      { numRuns: 20 },
    );
  });
});

describe("scrapePageupTenant", () => {
  it("builds deep-linked, validated jobs from a single-page board", async () => {
    server.use(http.get(LISTING_URL, () => new HttpResponse(CLASSIC_P1)));
    const out = await run();
    expect(out.result.status).toBe("success");
    expect(out.result.http_status).toBe(200);
    expect(out.result.jobs_count).toBe(3);
    const coord = out.jobs.find((j) => j.source_id === "945128");
    expect(coord?.url).toBe(
      `https://${HOST}/${INSTANCE}/${CLIENTKEY}/en/job/945128/senior-product-coordinator-just-jeans`,
    );
    expect(coord?.company).toBe("Just Group");
    expect(coord?.location_text).toBe("Various Locations");
    // Only a close-date is on the listing, never a posting date.
    expect(coord?.posted_at).toBeUndefined();
    expect(new Set(out.jobs.map((j) => j.id)).size).toBe(out.jobs.length);
  });

  it("walks pages until one yields no fresh ids", async () => {
    const requests: string[] = [];
    // 15 + 15 (full pages) then a short 3-row page ends the walk.
    const pages: Record<string, string> = {
      "1": pageOf(100, 15),
      "2": pageOf(200, 15),
      "3": pageOf(300, 3),
    };
    server.use(
      http.get(LISTING_URL, ({ request }) => {
        requests.push(request.url);
        const page = new URL(request.url).searchParams.get("page") ?? "1";
        return new HttpResponse(pages[page] ?? EMPTY);
      }),
    );
    const out = await run();
    expect(out.result.status).toBe("success");
    expect(out.result.jobs_count).toBe(33);
    expect(out.result.error).toBeUndefined();
    expect(requests).toHaveLength(3);
    expect(requests[1]).toContain("page=2");
    expect(requests[2]).toContain("page=3");
  });

  it("terminates on a full page followed by an empty past-the-end page", async () => {
    const requests: string[] = [];
    const pages: Record<string, string> = { "1": pageOf(100, 15), "2": EMPTY };
    server.use(
      http.get(LISTING_URL, ({ request }) => {
        requests.push(request.url);
        const page = new URL(request.url).searchParams.get("page") ?? "1";
        return new HttpResponse(pages[page] ?? EMPTY);
      }),
    );
    const out = await run();
    expect(out.result.jobs_count).toBe(15);
    expect(requests).toHaveLength(2);
  });

  it("dedupes ids repeated across pages (windowed board wrap)", async () => {
    const requests: string[] = [];
    // Page 2 repeats page 1's window entirely — no fresh ids ends the walk.
    server.use(
      http.get(LISTING_URL, ({ request }) => {
        requests.push(request.url);
        return new HttpResponse(pageOf(100, 15));
      }),
    );
    const out = await run();
    expect(out.result.jobs_count).toBe(15);
    expect(requests).toHaveLength(2); // page 1 full, page 2 all-duplicate → stop
    expect(new Set(out.jobs.map((j) => j.id)).size).toBe(15);
  });

  it("reports truncation when the page cap halts a full-page walk", async () => {
    const requests: string[] = [];
    server.use(
      http.get(LISTING_URL, ({ request }) => {
        requests.push(request.url);
        const page = new URL(request.url).searchParams.get("page") ?? "1";
        return new HttpResponse(pageOf(Number(page) * 1000, 15));
      }),
    );
    const out = await run(baseTenant(), { maxPages: 2 });
    expect(out.result.status).toBe("success");
    expect(out.result.error).toContain("capped");
    expect(requests).toHaveLength(2);
  });

  it("returns success with zero jobs for an empty board", async () => {
    server.use(http.get(LISTING_URL, () => new HttpResponse(EMPTY)));
    const out = await run();
    expect(out.result.status).toBe("success");
    expect(out.result.jobs_count).toBe(0);
  });

  it("retries on 5xx then succeeds", async () => {
    let n = 0;
    server.use(
      http.get(LISTING_URL, () => {
        n += 1;
        return n < 2 ? new HttpResponse("err", { status: 503 }) : new HttpResponse(CLASSIC_P1);
      }),
    );
    const out = await run();
    expect(n).toBe(2);
    expect(out.result.status).toBe("success");
  });

  it("marks dead on 404 and transient on exhausted 5xx", async () => {
    server.use(http.get(LISTING_URL, () => new HttpResponse("no", { status: 404 })));
    expect((await run()).result.status).toBe("dead");
    server.resetHandlers();
    server.use(http.get(LISTING_URL, () => new HttpResponse("err", { status: 502 })));
    expect((await run()).result.status).toBe("transient_failure");
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
    const out = await scrapePageupTenant({
      tenant: baseTenant(),
      client,
      observedAt: OBSERVED_AT,
      host: HOST,
      instance: INSTANCE,
      clientKey: CLIENTKEY,
    });
    expect(out.result.status).toBe("dead");
    expect(out.result.error).toContain("robots.txt");
  });

  it("marks the tenant dead on an unsafe slug", async () => {
    const out = await run(baseTenant({ slug: "Bad_Slug" }));
    expect(out.result.status).toBe("dead");
    expect(out.result.error).toContain("tenant slug rejected");
  });

  it("rejects a host outside the pageuppeople.com allow-set (SSRF guard)", async () => {
    const out = await run(baseTenant(), { host: "careers.pageuppeople.com.evil.com" });
    expect(out.result.status).toBe("dead");
    expect(out.result.error).toContain("pageup host rejected");
  });

  it("rejects a non-numeric instance and an unsafe clientkey", async () => {
    expect((await run(baseTenant(), { instance: "438/admin" })).result.error).toContain(
      "pageup instance rejected",
    );
    expect((await run(baseTenant(), { clientKey: "caw/../admin" })).result.error).toContain(
      "pageup clientkey rejected",
    );
  });
});
