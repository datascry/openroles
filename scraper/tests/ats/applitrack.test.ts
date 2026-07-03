import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from "bun:test";
import type { TenantInput } from "@openroles/shared";
import fc from "fast-check";
import { parseApplitrackListing, scrapeApplitrackTenant } from "../../src/ats/applitrack.ts";
import { HttpClient } from "../../src/http.ts";
import { RobotsTxtCache } from "../../src/robots.ts";
import {
  clientWithRobotsAllowAll,
  HttpResponse,
  http,
  makeServer,
  readFixtureText,
} from "../helpers.ts";

const OBSERVED_AT = "2026-07-01T00:00:00Z";
const SLUG = "unionsd";
// MSW matches on the path; the scraper's `?all=1` query is asserted implicitly
// by the handler resolving at all (msw warns on query strings in handler URLs).
const LISTING_URL = `https://www.applitrack.com/${SLUG}/onlineapp/jobpostings/Output.asp`;
const LISTING = readFixtureText("applitrack.listing.js");
const EMPTY = readFixtureText("applitrack.empty.js");
const EDGE = readFixtureText("applitrack.edge.js");

const server = makeServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function parse(
  body: string,
  tenant: TenantInput = { slug: SLUG, display_name: "Union School District" },
) {
  return parseApplitrackListing({
    tenant,
    company: tenant.display_name ?? tenant.slug,
    body,
    observedAt: OBSERVED_AT,
  });
}

function run(tenant: TenantInput): ReturnType<typeof scrapeApplitrackTenant> {
  return scrapeApplitrackTenant({
    tenant,
    client: clientWithRobotsAllowAll(),
    observedAt: OBSERVED_AT,
  });
}

describe("parseApplitrackListing (fixture replay)", () => {
  it("reassembles the document.write stream into validated, deep-linked Jobs", () => {
    const jobs = parse(LISTING);
    expect(jobs).toHaveLength(3);

    // Posting split mid-body across two document.write chunks still parses
    // whole — the payloads are concatenated before posting extraction.
    const director = jobs.find((j) => j.source_id === "1007");
    expect(director?.title).toBe("Director of Elementary Education");
    expect(director?.url).toBe(
      `https://www.applitrack.com/${SLUG}/onlineapp/jobpostings/view.asp?AppliTrackJobId=1007`,
    );
    expect(director?.company).toBe("Union School District");
    expect(director?.location_text).toBe("District Office");
    expect(director?.posted_at).toBe("2026-06-16T00:00:00.000Z");

    // Entity-laden title decodes; an escaped \' inside the JS string payload
    // survives as a literal apostrophe in the location.
    const slp = jobs.find((j) => j.source_id === "2004");
    expect(slp?.title).toBe("Speech & Language Pathologist");
    expect(slp?.location_text).toBe("St. Mary's Early Learning Center");
    expect(slp?.posted_at).toBe("2025-12-19T00:00:00.000Z");

    // A Date Posted equal to the observation instant is kept (<= guard).
    const custodian = jobs.find((j) => j.source_id === "680");
    expect(custodian?.title).toBe("High School Custodian");
    expect(custodian?.location_text).toBe("Union High School");
    expect(custodian?.posted_at).toBe("2026-07-01T00:00:00.000Z");

    expect(new Set(jobs.map((j) => j.id)).size).toBe(jobs.length);
  });

  it("returns no jobs for a board with no current openings", () => {
    expect(parse(EMPTY)).toHaveLength(0);
  });

  it("handles edge shapes: missing fields, duplicates, malformed blocks", () => {
    const jobs = parse(EDGE);
    // 300 (dup dropped), 301, 302, 305, 306, 307 — 304 has no title cell.
    expect(jobs.map((j) => j.source_id).sort()).toEqual(["300", "301", "302", "305", "306", "307"]);

    // Escaped quote in the JS payload decodes to a literal apostrophe.
    const ap = jobs.find((j) => j.source_id === "300");
    expect(ap?.title).toBe("Assistant Principal - O'Malley Campus");
    expect(ap?.posted_at).toBe("2026-05-04T00:00:00.000Z");

    // Missing Date Posted → posted_at omitted; location still extracted.
    const adult = jobs.find((j) => j.source_id === "301");
    expect(adult?.posted_at).toBeUndefined();
    expect(adult?.location_text).toBe("Adult Education Center");

    // Missing Location → location_text omitted gracefully.
    const bus = jobs.find((j) => j.source_id === "302");
    expect(bus?.location_text).toBeUndefined();
    expect(bus?.posted_at).toBe("2026-04-21T00:00:00.000Z");

    // Entity-laden title decodes (&amp; and numeric en-dash).
    const para = jobs.find((j) => j.source_id === "305");
    expect(para?.title).toBe("Paraprofessional & Aide – Special Education");

    // Unparseable date text → posted_at omitted, job kept.
    const mech = jobs.find((j) => j.source_id === "306");
    expect(mech?.posted_at).toBeUndefined();

    // Future-dated posting (after observedAt) → posted_at dropped, job kept.
    const teacher = jobs.find((j) => j.source_id === "307");
    expect(teacher?.posted_at).toBeUndefined();
    expect(teacher?.title).toBe("Elementary Teacher");
  });
});

describe("parseApplitrackListing (property)", () => {
  it("is deterministic on identical input", () => {
    fc.assert(
      fc.property(fc.constantFrom("unionsd", "tesd", "lmusd"), (slug) => {
        const a = parse(LISTING, { slug });
        const b = parse(LISTING, { slug });
        return JSON.stringify(a) === JSON.stringify(b);
      }),
      { numRuns: 15 },
    );
  });
});

describe("scrapeApplitrackTenant", () => {
  it("fetches the Output.asp blob and assembles jobs", async () => {
    server.use(http.get(LISTING_URL, () => new HttpResponse(LISTING)));
    const out = await run({ slug: SLUG, display_name: "Union School District" });
    expect(out.result.status).toBe("success");
    expect(out.result.jobs_count).toBe(3);
    expect(out.result.http_status).toBe(200);
    expect(
      out.jobs.every((j) => j.url.includes("/onlineapp/jobpostings/view.asp?AppliTrackJobId=")),
    ).toBe(true);
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
        return n < 2 ? new HttpResponse("err", { status: 503 }) : new HttpResponse(LISTING);
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
    const out = await scrapeApplitrackTenant({
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
