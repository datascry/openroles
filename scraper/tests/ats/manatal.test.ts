import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from "bun:test";
import type { TenantInput } from "@openroles/shared";
import fc from "fast-check";
import {
  parseManatalJobPage,
  parseManatalListing,
  scrapeManatalTenant,
} from "../../src/ats/manatal.ts";
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
const SLUG = "manatal";
const BOARD_URL = `https://www.careers-page.com/${SLUG}`;
const JOB1_URL = `https://www.careers-page.com/${SLUG}/job/L975Y966`;
const JOB2_URL = `https://www.careers-page.com/${SLUG}/job/3W35R9R8`;
const JOB3_URL = `https://www.careers-page.com/${SLUG}/job/V55YR`;

const BOARD_HTML = readFixtureText("manatal.board.html");
const DETAIL1_HTML = readFixtureText("manatal.detail-1.html");
const DETAIL2_HTML = readFixtureText("manatal.detail-2.html");
const DETAIL_BLR_HTML = readFixtureText("manatal.detail-blr.html");
const NO_JOBPOSTING_HTML = readFixtureText("manatal.detail-no-jobposting.html");
const FUTURE_HTML = readFixtureText("manatal.detail-future.html");

const server = makeServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function run(
  tenant: TenantInput,
  extra: Partial<Parameters<typeof scrapeManatalTenant>[0]> = {},
): ReturnType<typeof scrapeManatalTenant> {
  return scrapeManatalTenant({
    tenant,
    client: clientWithRobotsAllowAll(),
    observedAt: OBSERVED_AT,
    ...extra,
  });
}

describe("parseManatalListing (fixture replay)", () => {
  it("extracts the tenant's relative job links, deduped; ignores cross-tenant, root and asset links", () => {
    const entries = parseManatalListing(BOARD_HTML, SLUG);
    expect(entries.map((e) => e.sourceId)).toEqual(["L975Y966", "3W35R9R8", "V55YR"]);
    expect(entries[0]?.url).toBe(JOB1_URL);
    expect(entries[1]?.url).toBe(JOB2_URL);
    expect(entries[2]?.url).toBe(JOB3_URL);
    // The cross-tenant /othercorp/job/... link is never minted as a manatal job.
    expect(entries.some((e) => e.sourceId === "ZZZZ9999")).toBe(false);
  });

  it("returns an empty list for a board with no job links", () => {
    expect(parseManatalListing("<html><body>No openings</body></html>", SLUG)).toEqual([]);
  });

  it("drops a trailing query string but keeps the job code", () => {
    const html = `<a href="/${SLUG}/job/QW8RX956?ref=linkedin">x</a>`;
    const [entry] = parseManatalListing(html, SLUG);
    expect(entry?.sourceId).toBe("QW8RX956");
    expect(entry?.url).toBe(`https://www.careers-page.com/${SLUG}/job/QW8RX956`);
  });

  it("scopes matching to a hyphenated slug without leaking into another tenant", () => {
    const html = `<a href="/blr-world/job/5WR47RRR">x</a><a href="/blr-worldx/job/AAAA1111">y</a>`;
    const entries = parseManatalListing(html, "blr-world");
    expect(entries.map((e) => e.sourceId)).toEqual(["5WR47RRR"]);
  });
});

describe("parseManatalJobPage (fixture replay)", () => {
  it("builds a Job from the page's JobPosting JSON-LD", () => {
    const job = parseManatalJobPage({
      tenant: { slug: SLUG, display_name: "Manatal" },
      company: "Manatal",
      url: JOB1_URL,
      sourceId: "L975Y966",
      html: DETAIL1_HTML,
      observedAt: OBSERVED_AT,
    });
    expect(job).not.toBeNull();
    expect(job?.title).toBe("Product Analyst");
    expect(job?.source_id).toBe("L975Y966");
    expect(job?.url).toBe(JOB1_URL);
    expect(job?.company).toBe("Manatal");
    expect(job?.location_text).toBe("Bangkok, Thailand");
    // "Thailand" is not a 2-letter ISO code, so location_country stays unset.
    expect(job?.location_country).toBeUndefined();
    expect(job?.posted_at).toBe("2026-07-01T10:50:36.151Z");
    expect(job?.description_excerpt).toContain("Manatal");
    expect(job?.description_excerpt).not.toContain("<p>");
  });

  it("builds a Job from a second real detail page", () => {
    const job = parseManatalJobPage({
      tenant: { slug: SLUG },
      company: "Manatal",
      url: JOB2_URL,
      sourceId: "3W35R9R8",
      html: DETAIL2_HTML,
      observedAt: OBSERVED_AT,
    });
    expect(job?.title).toBe("Lead Sales Development Representative (Outbound)");
    expect(job?.posted_at).toBe("2026-06-15T03:17:07.423Z");
  });

  it("builds a Job from a hyphenated-slug tenant's detail page", () => {
    const job = parseManatalJobPage({
      tenant: { slug: "blr-world", display_name: "BLR WORLD" },
      company: "BLR WORLD",
      url: "https://www.careers-page.com/blr-world/job/5WR47RRR",
      sourceId: "5WR47RRR",
      html: DETAIL_BLR_HTML,
      observedAt: OBSERVED_AT,
    });
    expect(job?.title).toBe("Business Development Coordinator // BLR WORLD");
    expect(job?.location_text).toBe("Dubai, United Arab Emirates");
  });

  it("returns null when the page carries no JobPosting JSON-LD (edge)", () => {
    const job = parseManatalJobPage({
      tenant: { slug: SLUG },
      company: "Manatal",
      url: JOB1_URL,
      sourceId: "L975Y966",
      html: NO_JOBPOSTING_HTML,
      observedAt: OBSERVED_AT,
    });
    expect(job).toBeNull();
  });

  it("drops a future datePosted rather than failing the row", () => {
    const job = parseManatalJobPage({
      tenant: { slug: SLUG },
      company: "Manatal",
      url: JOB1_URL,
      sourceId: "L975Y966",
      html: FUTURE_HTML,
      observedAt: OBSERVED_AT,
    });
    expect(job).not.toBeNull();
    expect(job?.title).toBe("Future Posted Role");
    expect(job?.posted_at).toBeUndefined();
  });
});

describe("manatal parsers (property)", () => {
  it("listing + job-page parsing are deterministic on identical input", () => {
    fc.assert(
      fc.property(fc.constantFrom("manatal", "blr-world", "gaprecruitment"), (slug) => {
        const html = `<a href="/${slug}/job/Zz0011Aa">x</a>`;
        const a = parseManatalListing(html, slug);
        const b = parseManatalListing(html, slug);
        const pa = parseManatalJobPage({
          tenant: { slug },
          company: slug,
          url: a[0]?.url ?? "",
          sourceId: "Zz0011Aa",
          html: DETAIL1_HTML,
          observedAt: OBSERVED_AT,
        });
        const pb = parseManatalJobPage({
          tenant: { slug },
          company: slug,
          url: b[0]?.url ?? "",
          sourceId: "Zz0011Aa",
          html: DETAIL1_HTML,
          observedAt: OBSERVED_AT,
        });
        return JSON.stringify(a) === JSON.stringify(b) && JSON.stringify(pa) === JSON.stringify(pb);
      }),
      { numRuns: 20 },
    );
  });
});

describe("scrapeManatalTenant", () => {
  it("walks the board and assembles deep-linked Jobs from each job page", async () => {
    server.use(
      http.get(BOARD_URL, () => new HttpResponse(BOARD_HTML)),
      http.get(JOB1_URL, () => new HttpResponse(DETAIL1_HTML)),
      http.get(JOB2_URL, () => new HttpResponse(DETAIL2_HTML)),
      http.get(JOB3_URL, () => new HttpResponse(DETAIL_BLR_HTML)),
    );
    const out = await run({ slug: SLUG, display_name: "Manatal" });
    expect(out.result.status).toBe("success");
    expect(out.result.jobs_count).toBe(3);
    expect(out.result.http_status).toBe(200);
    expect(out.result.error).toBeUndefined();
    expect(new Set(out.jobs.map((j) => j.id)).size).toBe(3);
    // Every synthesised job carries the tenant's company + ats.
    expect(out.jobs.every((j) => j.ats === "manatal")).toBe(true);
  });

  it("dedupes a board that repeats the same job code across anchors", async () => {
    const dupBoard = `<a href="/${SLUG}/job/L975Y966">a</a><a href="/${SLUG}/job/L975Y966">b</a>`;
    server.use(
      http.get(BOARD_URL, () => new HttpResponse(dupBoard)),
      http.get(JOB1_URL, () => new HttpResponse(DETAIL1_HTML)),
    );
    const out = await run({ slug: SLUG });
    expect(out.result.jobs_count).toBe(1);
  });

  it("skips job pages with no JobPosting and reports the failure count", async () => {
    server.use(
      http.get(BOARD_URL, () => new HttpResponse(BOARD_HTML)),
      http.get(JOB1_URL, () => new HttpResponse(DETAIL1_HTML)),
      http.get(JOB2_URL, () => new HttpResponse(DETAIL2_HTML)),
      http.get(JOB3_URL, () => new HttpResponse(NO_JOBPOSTING_HTML)),
    );
    const out = await run({ slug: SLUG });
    expect(out.result.status).toBe("success");
    expect(out.result.jobs_count).toBe(2);
    expect(out.result.error).toContain("1/3 job pages failed");
  });

  it("reports transient_failure when more than half the job pages yield no JobPosting", async () => {
    server.use(
      http.get(BOARD_URL, () => new HttpResponse(BOARD_HTML)),
      http.get(JOB1_URL, () => new HttpResponse(NO_JOBPOSTING_HTML)),
      http.get(JOB2_URL, () => new HttpResponse(NO_JOBPOSTING_HTML)),
      http.get(JOB3_URL, () => new HttpResponse(DETAIL_BLR_HTML)),
    );
    const out = await run({ slug: SLUG });
    expect(out.result.status).toBe("transient_failure");
    expect(out.result.jobs_count).toBe(1);
  });

  it("treats a non-2xx job page as a skipped role, not a tenant failure", async () => {
    server.use(
      http.get(BOARD_URL, () => new HttpResponse(BOARD_HTML)),
      http.get(JOB1_URL, () => new HttpResponse(DETAIL1_HTML)),
      http.get(JOB2_URL, () => new HttpResponse(DETAIL2_HTML)),
      http.get(JOB3_URL, () => new HttpResponse("boom", { status: 500 })),
    );
    const out = await run({ slug: SLUG });
    expect(out.result.status).toBe("success");
    expect(out.result.jobs_count).toBe(2);
  });

  it("caps the detail fan-out and surfaces the truncation", async () => {
    const many = ["L975Y966", "3W35R9R8", "V55YR"]
      .map((c) => `<a href="/${SLUG}/job/${c}">x</a>`)
      .join("");
    server.use(
      http.get(BOARD_URL, () => new HttpResponse(many)),
      http.get(JOB1_URL, () => new HttpResponse(DETAIL1_HTML)),
      http.get(JOB2_URL, () => new HttpResponse(DETAIL2_HTML)),
      http.get(JOB3_URL, () => new HttpResponse(DETAIL_BLR_HTML)),
    );
    const out = await run({ slug: SLUG }, { maxDetailFetches: 2 });
    expect(out.result.jobs_count).toBe(2);
    expect(out.result.error).toContain("capped at 2 of 3 discovered roles");
  });

  it("returns success with zero jobs for an empty board", async () => {
    server.use(http.get(BOARD_URL, () => new HttpResponse("<html><body>none</body></html>")));
    const out = await run({ slug: SLUG });
    expect(out.result.status).toBe("success");
    expect(out.result.jobs_count).toBe(0);
    expect(out.result.error).toBeUndefined();
  });

  it("retries the board on 5xx then succeeds", async () => {
    let attempts = 0;
    server.use(
      http.get(BOARD_URL, () => {
        attempts += 1;
        if (attempts < 2) return new HttpResponse("err", { status: 503 });
        return new HttpResponse(BOARD_HTML);
      }),
      http.get(JOB1_URL, () => new HttpResponse(DETAIL1_HTML)),
      http.get(JOB2_URL, () => new HttpResponse(DETAIL2_HTML)),
      http.get(JOB3_URL, () => new HttpResponse(DETAIL_BLR_HTML)),
    );
    const out = await run({ slug: SLUG });
    expect(attempts).toBe(2);
    expect(out.result.status).toBe("success");
    expect(out.result.jobs_count).toBe(3);
  });

  it("marks the tenant dead when the board 404s (dead/unknown slug)", async () => {
    server.use(http.get(BOARD_URL, () => new HttpResponse("nope", { status: 404 })));
    const out = await run({ slug: SLUG });
    expect(out.result.status).toBe("dead");
    expect(out.result.http_status).toBe(404);
    expect(out.jobs).toHaveLength(0);
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
    const out = await scrapeManatalTenant({
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
