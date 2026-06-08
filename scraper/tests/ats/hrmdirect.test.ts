import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from "bun:test";
import type { TenantInput } from "@openroles/shared";
import fc from "fast-check";
import { parseHrmDirectListing, scrapeHrmDirectTenant } from "../../src/ats/hrmdirect.ts";
import { HttpClient } from "../../src/http.ts";
import { RobotsTxtCache } from "../../src/robots.ts";
import {
  clientWithRobotsAllowAll,
  HttpResponse,
  http,
  makeServer,
  readFixtureText,
} from "../helpers.ts";

const OBSERVED_AT = "2026-06-07T00:00:00Z";
const SLUG = "acme";
const LISTING_URL = `https://${SLUG}.hrmdirect.com/employment/job-openings.php?search=true`;
const LISTING = readFixtureText("hrmdirect.listing.html");
const EMPTY = readFixtureText("hrmdirect.empty.html");

const server = makeServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function parse(html: string, tenant: TenantInput = { slug: SLUG, display_name: "Acme Corp" }) {
  return parseHrmDirectListing({
    tenant,
    company: tenant.display_name ?? tenant.slug,
    html,
    observedAt: OBSERVED_AT,
  });
}

function run(tenant: TenantInput): ReturnType<typeof scrapeHrmDirectTenant> {
  return scrapeHrmDirectTenant({
    tenant,
    client: clientWithRobotsAllowAll(),
    observedAt: OBSERVED_AT,
  });
}

describe("parseHrmDirectListing (fixture replay)", () => {
  it("parses the table into validated, deep-linked Jobs", () => {
    const jobs = parse(LISTING);
    // 7 data rows: empty-title (5000) is skipped; req 999 has two locations;
    // 7001 is a custSort-only layout; 7002 has a nested-markup title.
    expect(jobs).toHaveLength(6);
    const eng = jobs.find((j) => j.title === "Senior Security Engineer");
    expect(eng?.source_id).toBe("3700461-1343077");
    expect(eng?.url).toBe(
      `https://${SLUG}.hrmdirect.com/employment/job-opening.php?req=3700461&req_loc=1343077`,
    );
    expect(eng?.company).toBe("Acme Corp");
    expect(eng?.location_text).toBe("Austin, TX");
    expect(eng?.location_region).toBe("TX");
    expect(eng?.department).toBe("Engineering");

    const remote = jobs.find((j) => j.title === "Remote Threat Intelligence Analyst");
    expect(remote?.workplace_type).toBe("remote"); // inferred from title
    expect(remote?.location_text).toBe("Remote"); // state cell was &nbsp; → dropped

    // HTML entities are decoded in the title.
    expect(jobs.filter((j) => j.title === "R&D Field Appraiser")).toHaveLength(2);
    // The same req in two locations yields two distinct rows/ids.
    const ids = jobs
      .filter((j) => j.title === "R&D Field Appraiser")
      .map((j) => j.source_id)
      .sort();
    expect(ids).toEqual(["999-1", "999-2"]);

    expect(jobs.some((j) => j.source_id.startsWith("5000"))).toBe(false); // empty-title row skipped

    // custSort-only layout: valid Job, but no semantic columns → location and
    // department gracefully omitted rather than guessed.
    const custSort = jobs.find((j) => j.title === "Principal Consultant");
    expect(custSort?.source_id).toBe("7001-10");
    expect(custSort?.location_text).toBeUndefined();
    expect(custSort?.department).toBeUndefined();

    // Nested-markup title is preserved (tags stripped), and a `statename`
    // decoy cell is NOT mistaken for the `state` column (whole-token match).
    const nested = jobs.find((j) => j.title === "Staff Platform Engineer");
    expect(nested?.location_text).toBe("Seattle, WA");
    expect(nested?.location_region).toBe("WA");
    expect(nested?.department).toBe("Engineering");

    expect(new Set(jobs.map((j) => j.id)).size).toBe(jobs.length);
  });

  it("returns no jobs for an empty board", () => {
    expect(parse(EMPTY)).toHaveLength(0);
  });
});

describe("parseHrmDirectListing (property)", () => {
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

describe("scrapeHrmDirectTenant", () => {
  it("fetches the board and assembles jobs", async () => {
    server.use(http.get(LISTING_URL, () => new HttpResponse(LISTING)));
    const out = await run({ slug: SLUG, display_name: "Acme Corp" });
    expect(out.result.status).toBe("success");
    expect(out.result.jobs_count).toBe(6);
    expect(out.result.http_status).toBe(200);
    expect(out.jobs.every((j) => j.url.includes("/employment/job-opening.php?req="))).toBe(true);
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
    const out = await scrapeHrmDirectTenant({
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
