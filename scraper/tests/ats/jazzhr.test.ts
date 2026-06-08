import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from "bun:test";
import type { TenantInput } from "@openroles/shared";
import fc from "fast-check";
import {
  parseJazzHrJobPage,
  parseJazzHrListing,
  scrapeJazzHrTenant,
} from "../../src/ats/jazzhr.ts";
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
const HOST = "acme.applytojob.com";
const LISTING_URL = `https://${HOST}/apply/`;
const JOB1_URL = `https://${HOST}/apply/AbC123dEf0/Senior-Security-Engineer`;
const JOB2_URL = `https://${HOST}/apply/Zy9X8w7V6u/Threat-Intelligence-Analyst`;

const LISTING_HTML = readFixtureText("jazzhr.listing.html");
const DETAIL_HTML = readFixtureText("jazzhr.detail.html");
const NO_JOBPOSTING_HTML = readFixtureText("jazzhr.detail-no-jobposting.html");

const server = makeServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function run(tenant: TenantInput): ReturnType<typeof scrapeJazzHrTenant> {
  return scrapeJazzHrTenant({
    tenant,
    client: clientWithRobotsAllowAll(),
    observedAt: OBSERVED_AT,
  });
}

describe("parseJazzHrListing (fixture replay)", () => {
  it("extracts host-anchored job links, deduped; ignores non-job, cross-host and bare links", () => {
    const entries = parseJazzHrListing(LISTING_HTML, HOST);
    expect(entries.map((e) => e.sourceId)).toEqual(["AbC123dEf0", "Zy9X8w7V6u"]);
    expect(entries[0]?.url).toBe(JOB1_URL);
    expect(entries[1]?.url).toBe(JOB2_URL);
    // The /cb/ feed link, the evil.example.com cross-host link, and the bare
    // /apply/ link are all excluded.
    expect(entries.some((e) => e.sourceId === "HACKER0001")).toBe(false);
  });

  it("returns an empty list for a board with no job links", () => {
    expect(parseJazzHrListing("<html><body>No openings</body></html>", HOST)).toEqual([]);
  });

  it("drops the query string but keeps the title-slug path segment", () => {
    const html = `<a href="https://${HOST}/apply/QwErTy1234/Staff-Engineer?source=GS">x</a>`;
    const [entry] = parseJazzHrListing(html, HOST);
    expect(entry?.url).toBe(`https://${HOST}/apply/QwErTy1234/Staff-Engineer`);
  });
});

describe("parseJazzHrJobPage (fixture replay)", () => {
  it("builds a Job from the page's JobPosting JSON-LD", () => {
    const job = parseJazzHrJobPage({
      tenant: { slug: "acme", display_name: "Acme Corp" },
      company: "Acme Corp",
      url: JOB1_URL,
      sourceId: "AbC123dEf0",
      html: DETAIL_HTML,
      observedAt: OBSERVED_AT,
    });
    expect(job).not.toBeNull();
    expect(job?.title).toBe("Senior Security Engineer");
    expect(job?.source_id).toBe("AbC123dEf0");
    expect(job?.url).toBe(JOB1_URL);
    expect(job?.company).toBe("Acme Corp");
    expect(job?.location_text).toBe("Austin, TX, US");
    expect(job?.location_country).toBe("US");
    expect(job?.location_region).toBe("TX");
    expect(job?.posted_at).toBe("2026-03-12T00:00:00Z");
    expect(job?.description_excerpt).toContain("Lead our threat detection");
    expect(job?.description_excerpt).not.toContain("<p>");
  });

  it("returns null when the page carries no JobPosting JSON-LD (edge)", () => {
    const job = parseJazzHrJobPage({
      tenant: { slug: "acme" },
      company: "Acme",
      url: JOB1_URL,
      sourceId: "AbC123dEf0",
      html: NO_JOBPOSTING_HTML,
      observedAt: OBSERVED_AT,
    });
    expect(job).toBeNull();
  });
});

describe("jazzhr parsers (property)", () => {
  it("listing + job-page parsing are deterministic on identical input", () => {
    fc.assert(
      fc.property(fc.constantFrom("acme", "globex", "initech"), (slug) => {
        const host = `${slug}.applytojob.com`;
        const html = `<a href="https://${host}/apply/Zz0011AaBb/Role">x</a>`;
        const a = parseJazzHrListing(html, host);
        const b = parseJazzHrListing(html, host);
        const pa = parseJazzHrJobPage({
          tenant: { slug },
          company: slug,
          url: a[0]?.url ?? "",
          sourceId: "Zz0011AaBb",
          html: DETAIL_HTML,
          observedAt: OBSERVED_AT,
        });
        const pb = parseJazzHrJobPage({
          tenant: { slug },
          company: slug,
          url: b[0]?.url ?? "",
          sourceId: "Zz0011AaBb",
          html: DETAIL_HTML,
          observedAt: OBSERVED_AT,
        });
        return JSON.stringify(a) === JSON.stringify(b) && JSON.stringify(pa) === JSON.stringify(pb);
      }),
      { numRuns: 20 },
    );
  });
});

describe("scrapeJazzHrTenant", () => {
  it("walks the board and assembles deep-linked Jobs from each job page", async () => {
    server.use(
      http.get(LISTING_URL, () => new HttpResponse(LISTING_HTML)),
      http.get(JOB1_URL, () => new HttpResponse(DETAIL_HTML)),
      http.get(JOB2_URL, () => new HttpResponse(DETAIL_HTML)),
    );
    const out = await run({ slug: "acme", display_name: "Acme Corp" });
    expect(out.result.status).toBe("success");
    expect(out.result.jobs_count).toBe(2);
    expect(out.result.http_status).toBe(200);
    const urls = out.jobs.map((j) => j.url).sort();
    expect(urls).toEqual([JOB1_URL, JOB2_URL]);
    expect(new Set(out.jobs.map((j) => j.id)).size).toBe(2);
  });

  it("skips job pages with no JobPosting and reports the failure count", async () => {
    server.use(
      http.get(LISTING_URL, () => new HttpResponse(LISTING_HTML)),
      http.get(JOB1_URL, () => new HttpResponse(DETAIL_HTML)),
      http.get(JOB2_URL, () => new HttpResponse(NO_JOBPOSTING_HTML)),
    );
    const out = await run({ slug: "acme" });
    expect(out.result.status).toBe("success");
    expect(out.result.jobs_count).toBe(1);
    expect(out.result.error).toContain("1/2 job pages failed");
  });

  it("reports transient_failure when more than half the job pages yield no JobPosting", async () => {
    server.use(
      http.get(LISTING_URL, () => new HttpResponse(LISTING_HTML)),
      http.get(JOB1_URL, () => new HttpResponse(NO_JOBPOSTING_HTML)),
      http.get(JOB2_URL, () => new HttpResponse(NO_JOBPOSTING_HTML)),
    );
    const out = await run({ slug: "acme" });
    expect(out.result.status).toBe("transient_failure");
    expect(out.result.jobs_count).toBe(0);
  });

  it("treats a non-2xx job page as a skipped role, not a tenant failure", async () => {
    server.use(
      http.get(LISTING_URL, () => new HttpResponse(LISTING_HTML)),
      http.get(JOB1_URL, () => new HttpResponse(DETAIL_HTML)),
      http.get(JOB2_URL, () => new HttpResponse("boom", { status: 500 })),
    );
    const out = await run({ slug: "acme" });
    expect(out.result.status).toBe("success");
    expect(out.result.jobs_count).toBe(1);
  });

  it("returns success with zero jobs for an empty board", async () => {
    server.use(http.get(LISTING_URL, () => new HttpResponse("<html><body>none</body></html>")));
    const out = await run({ slug: "acme" });
    expect(out.result.status).toBe("success");
    expect(out.result.jobs_count).toBe(0);
  });

  it("retries the board on 5xx then succeeds", async () => {
    let attempts = 0;
    server.use(
      http.get(LISTING_URL, () => {
        attempts += 1;
        if (attempts < 2) return new HttpResponse("err", { status: 503 });
        return new HttpResponse(LISTING_HTML);
      }),
      http.get(JOB1_URL, () => new HttpResponse(DETAIL_HTML)),
      http.get(JOB2_URL, () => new HttpResponse(DETAIL_HTML)),
    );
    const out = await run({ slug: "acme" });
    expect(attempts).toBe(2);
    expect(out.result.status).toBe("success");
    expect(out.result.jobs_count).toBe(2);
  });

  it("marks the tenant dead when the board 404s", async () => {
    server.use(http.get(LISTING_URL, () => new HttpResponse("nope", { status: 404 })));
    const out = await run({ slug: "acme" });
    expect(out.result.status).toBe("dead");
    expect(out.result.http_status).toBe(404);
    expect(out.jobs).toHaveLength(0);
  });

  it("marks the tenant transient_failure on exhausted board retries", async () => {
    server.use(http.get(LISTING_URL, () => new HttpResponse("err", { status: 502 })));
    const out = await run({ slug: "acme" });
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
    const out = await scrapeJazzHrTenant({
      tenant: { slug: "acme" },
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
