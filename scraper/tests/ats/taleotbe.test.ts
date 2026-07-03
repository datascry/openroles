import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from "bun:test";
import type { TenantInput } from "@openroles/shared";
import fc from "fast-check";
import { parseTaleoTbeListing, scrapeTaleoTbeTenant } from "../../src/ats/taleotbe.ts";
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
const HOST = "phh.tbe.taleo.net";
const INSTANCE = "phh03";
const CWS = "37";
const SEARCH_URL = `https://${HOST}/${INSTANCE}/ats/careers/v2/searchResults`;

const PAGE1 = readFixtureText("taleotbe.listing.page1.html");
const PAGE2 = readFixtureText("taleotbe.listing.page2.html");
const EDGE = readFixtureText("taleotbe.listing.edge.html");
const EMPTY = readFixtureText("taleotbe.empty.html");

const server = makeServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function run(
  tenant: TenantInput,
  overrides: { host?: string; instance?: string; cws?: string } = {},
): ReturnType<typeof scrapeTaleoTbeTenant> {
  return scrapeTaleoTbeTenant({
    tenant,
    client: clientWithRobotsAllowAll(),
    observedAt: OBSERVED_AT,
    host: overrides.host ?? HOST,
    instance: overrides.instance ?? INSTANCE,
    cws: overrides.cws ?? CWS,
  });
}

describe("parseTaleoTbeListing (fixture replay)", () => {
  it("parses the full first page into rows with rid, title and location", () => {
    const rows = parseTaleoTbeListing(PAGE1, "invxis");
    expect(rows).toHaveLength(10);
    expect(rows[0]).toEqual({
      rid: "3001",
      title: "Action Officer I",
      location: "Chantilly, VA",
    });
    expect(rows.map((r) => r.rid)).toEqual([
      "3001",
      "3002",
      "3003",
      "3004",
      "3005",
      "3006",
      "3007",
      "3008",
      "3009",
      "3010",
    ]);
  });

  it("parses the short second page, tolerating a row without a location", () => {
    const rows = parseTaleoTbeListing(PAGE2, "invxis");
    expect(rows).toHaveLength(3);
    expect(rows[2]?.rid).toBe("3013");
    expect(rows[2]?.title).toBe("Test Engineer 1");
    expect(rows[2]?.location).toBeUndefined();
  });

  it("handles the edge page: entities decoded, rid-less / foreign-org / blank-title anchors skipped", () => {
    const rows = parseTaleoTbeListing(EDGE, "invxis");
    // 4001 (twice — parse preserves the duplicate; the scrape loop dedupes)
    // and 4002; the rid-less "Ghost Role", OTHERCO's 4003 and the
    // whitespace-only 4004 are all skipped.
    expect(rows.map((r) => r.rid)).toEqual(["4001", "4002", "4001"]);
    expect(rows[0]?.title).toBe("Staff Engineer & Architect (R&D)");
    expect(rows[0]?.location).toBe("München, Germany");
    expect(rows[1]?.title).toBe("Senior Analyst");
    expect(rows[1]?.location).toBe("Québec, QC");
  });

  it("matches the tenant org case-insensitively (anchors render the canonical uppercase)", () => {
    expect(parseTaleoTbeListing(PAGE1, "INVXIS")).toHaveLength(10);
    expect(parseTaleoTbeListing(PAGE1, "otherco")).toHaveLength(0);
  });

  it("returns no rows for an empty board page", () => {
    expect(parseTaleoTbeListing(EMPTY, "invxis")).toEqual([]);
  });
});

describe("parseTaleoTbeListing (property)", () => {
  it("is deterministic on identical input", () => {
    fc.assert(
      fc.property(fc.constantFrom(PAGE1, PAGE2, EDGE, EMPTY), (html) => {
        const a = parseTaleoTbeListing(html, "invxis");
        const b = parseTaleoTbeListing(html, "invxis");
        return JSON.stringify(a) === JSON.stringify(b);
      }),
      { numRuns: 20 },
    );
  });
});

describe("scrapeTaleoTbeTenant", () => {
  it("walks pages with the JSESSIONID echo until a short page ends the listing", async () => {
    // A plain fetch mock (not MSW) so the cookie header observed is
    // exactly what the adapter sent — MSW keeps a virtual cookie jar of
    // its own that would append the Set-Cookie pair a second time and
    // mask whether the adapter's echo works.
    const calls: Array<{ rowFrom: string | null; cookie: string | null }> = [];
    const fetchFn = (async (input: Request | string | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : {}));
      calls.push({ rowFrom: url.searchParams.get("rowFrom"), cookie: headers.get("cookie") });
      if (url.searchParams.get("rowFrom") === null) {
        return new Response(PAGE1, {
          headers: { "set-cookie": "JSESSIONID=ABC123DEF456; Path=/phh03/ats; Secure; HttpOnly" },
        });
      }
      return new Response(PAGE2);
    }) as typeof globalThis.fetch;
    const out = await scrapeTaleoTbeTenant({
      tenant: { slug: "invxis", display_name: "RealmOne" },
      client: clientWithRobotsAllowAll({ fetchFn }),
      observedAt: OBSERVED_AT,
      host: HOST,
      instance: INSTANCE,
      cws: CWS,
    });
    expect(out.result.status).toBe("success");
    expect(out.result.jobs_count).toBe(13);
    expect(calls).toEqual([
      { rowFrom: null, cookie: null },
      { rowFrom: "10", cookie: "JSESSIONID=ABC123DEF456" },
    ]);
    const first = out.jobs[0];
    expect(first?.title).toBe("Action Officer I");
    expect(first?.company).toBe("RealmOne");
    expect(first?.source_id).toBe("3001");
    expect(first?.url).toBe(
      `https://${HOST}/${INSTANCE}/ats/careers/v2/viewRequisition?org=invxis&cws=${CWS}&rid=3001`,
    );
    expect(first?.location_text).toBe("Chantilly, VA");
    // No clean posted date on the listing → posted_at is never guessed.
    expect(out.jobs.every((j) => j.posted_at === undefined)).toBe(true);
  });

  it("ends the walk when a page repeats (no fresh rids)", async () => {
    let n = 0;
    server.use(
      http.get(SEARCH_URL, () => {
        n += 1;
        return new HttpResponse(PAGE1, {
          headers: { "Set-Cookie": "JSESSIONID=REPEAT1; Path=/phh03/ats" },
        });
      }),
    );
    const out = await run({ slug: "invxis" });
    expect(out.result.status).toBe("success");
    expect(out.result.jobs_count).toBe(10);
    // Page 1 (10 fresh rids) + page 2 (all repeats → stop). No page 3.
    expect(n).toBe(2);
  });

  it("stops after page 1 when the server sets no session cookie (later pages come back empty)", async () => {
    let n = 0;
    server.use(
      http.get(SEARCH_URL, ({ request }) => {
        n += 1;
        // A cookie-less rowFrom request is served as an empty page — the
        // observed live behaviour when the JSESSIONID echo is missing.
        if (new URL(request.url).searchParams.get("rowFrom") !== null) {
          return new HttpResponse("\n");
        }
        return new HttpResponse(PAGE1);
      }),
    );
    const out = await run({ slug: "invxis" });
    expect(out.result.status).toBe("success");
    expect(out.result.jobs_count).toBe(10);
    expect(n).toBe(2);
  });

  it("dedupes a duplicate rid within a page", async () => {
    server.use(http.get(SEARCH_URL, () => new HttpResponse(EDGE)));
    const out = await run({ slug: "invxis" });
    expect(out.result.status).toBe("success");
    expect(out.result.jobs_count).toBe(2);
    expect(out.jobs.map((j) => j.source_id)).toEqual(["4001", "4002"]);
  });

  it("returns success with zero jobs on an empty board", async () => {
    server.use(http.get(SEARCH_URL, () => new HttpResponse(EMPTY)));
    const out = await run({ slug: "invxis" });
    expect(out.result.status).toBe("success");
    expect(out.result.jobs_count).toBe(0);
  });

  it("caps the walk at maxPages", async () => {
    let n = 0;
    // Every page returns 10 fresh rids, so only the cap can end the walk.
    server.use(
      http.get(SEARCH_URL, () => {
        n += 1;
        const rows = Array.from({ length: 10 }, (_, i) => {
          const rid = n * 100 + i;
          return `<h4 class="oracletaleocwsv2-head-title"><a href="https://${HOST}/${INSTANCE}/ats/careers/v2/viewRequisition?org=INVXIS&cws=${CWS}&rid=${rid}" class="viewJobLink">Role ${rid}</a></h4>\n<div tabindex="0" >Chantilly, VA</div>`;
        }).join("\n");
        return new HttpResponse(`<html><body>${rows}</body></html>`, {
          headers: { "Set-Cookie": "JSESSIONID=CAP1; Path=/phh03/ats" },
        });
      }),
    );
    const out = await scrapeTaleoTbeTenant({
      tenant: { slug: "invxis" },
      client: clientWithRobotsAllowAll(),
      observedAt: OBSERVED_AT,
      host: HOST,
      instance: INSTANCE,
      cws: CWS,
      maxPages: 3,
    });
    expect(n).toBe(3);
    expect(out.result.jobs_count).toBe(30);
    expect(out.result.error).toContain("capped");
  });

  it("retries on 5xx then succeeds", async () => {
    let n = 0;
    server.use(
      http.get(SEARCH_URL, () => {
        n += 1;
        return n < 2 ? new HttpResponse("err", { status: 503 }) : new HttpResponse(PAGE2);
      }),
    );
    const out = await run({ slug: "invxis" });
    expect(n).toBe(2);
    expect(out.result.status).toBe("success");
    expect(out.result.jobs_count).toBe(3);
  });

  it("marks dead on 404 and transient on exhausted 5xx", async () => {
    server.use(http.get(SEARCH_URL, () => new HttpResponse("no", { status: 404 })));
    expect((await run({ slug: "invxis" })).result.status).toBe("dead");
    server.resetHandlers();
    server.use(http.get(SEARCH_URL, () => new HttpResponse("err", { status: 502 })));
    expect((await run({ slug: "invxis" })).result.status).toBe("transient_failure");
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
    const out = await scrapeTaleoTbeTenant({
      tenant: { slug: "invxis" },
      client,
      observedAt: OBSERVED_AT,
      host: HOST,
      instance: INSTANCE,
      cws: CWS,
    });
    expect(out.result.status).toBe("dead");
    expect(out.result.error).toContain("robots.txt");
  });

  it("rejects hosts outside the TBE pod pool (SSRF guard)", async () => {
    for (const host of [
      "evil.com",
      "phh.tbe.taleo.net.evil.com", // suffix spoof
      "tbe.taleo.net", // bare shared host, no pod label
      "phh.taleo.net", // enterprise pool, not TBE
      "169.254.169.254",
      "PHH.tbe.taleo.net", // uppercase label — metadata is stored lowercase
      "phh.tbe.taleo.net/evil", // path injection
      "", // empty
    ]) {
      const out = await run({ slug: "invxis" }, { host });
      expect(out.result.status).toBe("dead");
      expect(out.result.error).toContain("taleotbe host rejected");
    }
  });

  it("rejects a malformed instance or cws", async () => {
    const badInstance = await run({ slug: "invxis" }, { instance: "phh03/evil" });
    expect(badInstance.result.status).toBe("dead");
    expect(badInstance.result.error).toContain("taleotbe instance rejected");
    const badCws = await run({ slug: "invxis" }, { cws: "37&org=other" });
    expect(badCws.result.status).toBe("dead");
    expect(badCws.result.error).toContain("taleotbe cws rejected");
  });

  it("rejects an unsafe slug", async () => {
    const out = await run({ slug: "Bad_Org" });
    expect(out.result.status).toBe("dead");
    expect(out.result.error).toContain("tenant slug rejected");
  });
});
