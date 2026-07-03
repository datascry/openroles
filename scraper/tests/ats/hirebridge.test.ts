import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from "bun:test";
import type { TenantInput } from "@openroles/shared";
import fc from "fast-check";
import { parseHirebridgeListing, scrapeHirebridgeTenant } from "../../src/ats/hirebridge.ts";
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
const CID = "5535";
const EDGE_CID = "8419";
const LISTING_URL = `https://recruit.hirebridge.com/v3/jobs/list.aspx?cid=${CID}`;
const LISTING = readFixtureText("hirebridge.listing.html");
const EMPTY = readFixtureText("hirebridge.empty.html");
const EDGE = readFixtureText("hirebridge.edge.html");

const server = makeServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function parse(html: string, tenant: TenantInput = { slug: CID, display_name: "Menard Inc" }) {
  return parseHirebridgeListing({
    tenant,
    company: tenant.display_name ?? tenant.slug,
    html,
    observedAt: OBSERVED_AT,
  });
}

function run(tenant: TenantInput): ReturnType<typeof scrapeHirebridgeTenant> {
  return scrapeHirebridgeTenant({
    tenant,
    client: clientWithRobotsAllowAll(),
    observedAt: OBSERVED_AT,
  });
}

describe("parseHirebridgeListing (fixture replay)", () => {
  it("parses location-grouped anchors into validated, deep-linked Jobs", () => {
    const jobs = parse(LISTING);
    // 4 anchors in the fixture: 3 for this cid, 1 pointing at a different
    // cid (skipped — a board never lists another tenant's roles). The
    // applink.aspx resume link is not a JobDetails anchor and never matches.
    expect(jobs).toHaveLength(3);

    const trainee = jobs.find((j) => j.title === "Manager Trainee");
    expect(trainee?.source_id).toBe("411726");
    // The canonical public URL is the CareerCenter details page, keyed by
    // (cid, jid) alone — the listing's `bid` parameter is not carried over.
    expect(trainee?.url).toBe(
      `https://recruit.hirebridge.com/v3/CareerCenter/v2/details.aspx?cid=${CID}&jid=411726`,
    );
    expect(trainee?.company).toBe("Menard Inc");
    // Location comes from the groupbyname heading the anchor sits under.
    expect(trainee?.location_text).toBe("ABERDEEN, SD");
    expect(trainee?.location_region).toBe("SD");
    // Whitespace-only department cell → omitted, not an empty string.
    expect(trainee?.department).toBeUndefined();

    const eng = jobs.find((j) => j.title === "Senior Security Engineer");
    expect(eng?.source_id).toBe("411800");
    expect(eng?.location_text).toBe("Austin, TX");
    expect(eng?.location_region).toBe("TX");
    expect(eng?.department).toBe("Engineering");

    const remote = jobs.find((j) => j.title === "Remote Threat Intelligence Analyst");
    expect(remote?.workplace_type).toBe("remote"); // inferred from title
    expect(remote?.department).toBe("Security");

    // The cross-cid anchor is skipped entirely.
    expect(jobs.some((j) => j.source_id === "555000")).toBe(false);

    expect(new Set(jobs.map((j) => j.id)).size).toBe(jobs.length);
  });

  it("parses the h2-heading layout and survives the edge shapes", () => {
    const jobs = parse(EDGE, { slug: EDGE_CID, display_name: "Rinker Materials" });
    // 6 anchors: orphan + duplicate pair (dedupes to one) + empty-title
    // (skipped) + nested-markup title + location-echo department → 4 jobs.
    expect(jobs).toHaveLength(4);

    // An anchor before any location heading keeps the Job but omits the
    // location rather than inheriting the page's marketing-copy <h2> (which
    // is styled, not the bare `<div class="row"><h2>` group heading).
    const orphan = jobs.find((j) => j.title === "Orphan Coordinator");
    expect(orphan?.location_text).toBeUndefined();
    expect(orphan?.department).toBeUndefined();

    // HTML entities in the title decode exactly once (R&amp;D → R&D).
    const tech = jobs.find((j) => j.title === "R&D Process Technician");
    expect(tech?.source_id).toBe("900002");
    expect(tech?.location_text).toBe("ALEXANDRIA, LA (MSYCP)");
    expect(tech?.department).toBe("Hourly Production");
    // The duplicate jid renders one Job, not two.
    expect(jobs.filter((j) => j.source_id === "900002")).toHaveLength(1);

    // Whitespace-only anchor text is not a title → the anchor is skipped.
    expect(jobs.some((j) => j.source_id === "900003")).toBe(false);

    // Nested markup inside the anchor is flattened, not truncated.
    const nested = jobs.find((j) => j.source_id === "900004");
    expect(nested?.title).toBe("Staff Platform Engineer");
    expect(nested?.location_text).toBe("SEATTLE, WA (SEACP)");
    expect(nested?.department).toBe("Engineering");

    // Some tenants reuse the department span for the city, so it merely
    // echoes the group heading — an echo is not a department and is
    // omitted rather than stored as a duplicate of location_text.
    const echo = jobs.find((j) => j.source_id === "900005");
    expect(echo?.title).toBe("Batch Plant Operator");
    expect(echo?.location_text).toBe("SEATTLE, WA (SEACP)");
    expect(echo?.department).toBeUndefined();

    expect(new Set(jobs.map((j) => j.id)).size).toBe(jobs.length);
  });

  it("returns no jobs for an empty board", () => {
    expect(parse(EMPTY)).toHaveLength(0);
  });
});

describe("parseHirebridgeListing (property)", () => {
  it("is deterministic on identical input", () => {
    fc.assert(
      fc.property(fc.constantFrom("5535", "8419", "7997"), (slug) => {
        const a = parse(LISTING, { slug });
        const b = parse(LISTING, { slug });
        return JSON.stringify(a) === JSON.stringify(b);
      }),
      { numRuns: 15 },
    );
  });
});

describe("scrapeHirebridgeTenant", () => {
  it("fetches the board and assembles jobs", async () => {
    server.use(http.get(LISTING_URL, () => new HttpResponse(LISTING)));
    const out = await run({ slug: CID, display_name: "Menard Inc" });
    expect(out.result.status).toBe("success");
    expect(out.result.jobs_count).toBe(3);
    expect(out.result.http_status).toBe(200);
    expect(out.jobs.every((j) => j.url.includes("/v3/CareerCenter/v2/details.aspx?cid="))).toBe(
      true,
    );
  });

  it("returns success with zero jobs for an empty board", async () => {
    server.use(http.get(LISTING_URL, () => new HttpResponse(EMPTY)));
    const out = await run({ slug: CID });
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
    const out = await run({ slug: CID });
    expect(n).toBe(2);
    expect(out.result.status).toBe("success");
  });

  it("marks dead on 404 and transient on exhausted 5xx", async () => {
    server.use(http.get(LISTING_URL, () => new HttpResponse("no", { status: 404 })));
    expect((await run({ slug: CID })).result.status).toBe("dead");
    server.resetHandlers();
    server.use(http.get(LISTING_URL, () => new HttpResponse("err", { status: 502 })));
    expect((await run({ slug: CID })).result.status).toBe("transient_failure");
  });

  it("marks dead on the vendor error-page redirect (unknown cid)", async () => {
    // An unknown cid answers the listing with a same-host 302 to
    // `/v3/Application/AppErrMsg.aspx?cid={cid}&errorType=badurl`. The
    // redirect target — not a 4xx — is the dead signal, so the request is
    // made with redirect:manual and the Location classified directly.
    const fetchFn = mock(
      async () =>
        new Response(null, {
          status: 302,
          headers: {
            location:
              "https://recruit.hirebridge.com/v3/Application/AppErrMsg.aspx?cid=5535&errorType=badurl",
          },
        }),
    );
    const out = await scrapeHirebridgeTenant({
      tenant: { slug: CID },
      client: clientWithRobotsAllowAll({ fetchFn }),
      observedAt: OBSERVED_AT,
    });
    expect(out.result.status).toBe("dead");
    expect(out.result.http_status).toBe(302);
    expect(out.result.error).toContain("error page");
  });

  it("marks an unrecognized redirect transient, not dead", async () => {
    // Any 3xx that is NOT the vendor error page is unexplained — keep the
    // tenant alive (transient_failure) rather than dropping it on a shape
    // we have not observed.
    const fetchFn = mock(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://recruit.hirebridge.com/v3/jobs/list.aspx?cid=5535&p=1" },
        }),
    );
    const out = await scrapeHirebridgeTenant({
      tenant: { slug: CID },
      client: clientWithRobotsAllowAll({ fetchFn }),
      observedAt: OBSERVED_AT,
    });
    expect(out.result.status).toBe("transient_failure");
    expect(out.result.error).toContain("redirect");
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
    const out = await scrapeHirebridgeTenant({
      tenant: { slug: CID },
      client,
      observedAt: OBSERVED_AT,
    });
    expect(out.result.status).toBe("dead");
    expect(out.result.error).toContain("robots.txt");
  });

  it("marks the tenant dead on a non-numeric cid", async () => {
    // Hirebridge tenancy is a numeric cid; anything else would be a
    // template-injection vector into the query string, so it is rejected
    // before any request is made.
    const out = await run({ slug: "acme" });
    expect(out.result.status).toBe("dead");
    expect(out.result.error).toContain("hirebridge cid rejected");
  });
});
