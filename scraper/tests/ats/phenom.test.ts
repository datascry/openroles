import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from "bun:test";
import type { TenantInput } from "@openroles/shared";
import fc from "fast-check";
import { parsePhenomSearchPage, phenomJobToJob, scrapePhenomTenant } from "../../src/ats/phenom.ts";
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
const HOST = "careers.acme.com";
const LOCALE = "us/en";
const SEARCH_PATH = `https://${HOST}/${LOCALE}/search-results`;

const SMALL = readFixtureText("phenom.search.small.html");
const EDGE = readFixtureText("phenom.search.edge.html");
const NOJSON = readFixtureText("phenom.search.nojson.html");

const server = makeServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function run(
  tenant: TenantInput,
  overrides: { host?: string; locale?: string } = {},
): ReturnType<typeof scrapePhenomTenant> {
  return scrapePhenomTenant({
    tenant,
    client: clientWithRobotsAllowAll(),
    observedAt: OBSERVED_AT,
    host: overrides.host ?? HOST,
    locale: overrides.locale ?? LOCALE,
  });
}

// Build a Phenom search page embedding `eagerLoadRefineSearch` with the given
// job window + totalHits — used to drive the pagination test.
function phenomPage(jobs: object[], totalHits: number): string {
  const payload = JSON.stringify({ status: 200, hits: jobs.length, totalHits, data: { jobs } });
  return `<html><head><script>phApp.ddo = {"eagerLoadRefineSearch":${payload}};</script></head><body></body></html>`;
}

describe("parsePhenomSearchPage (fixture replay)", () => {
  it("parses the small fixture's embedded eager-load block", () => {
    const page = parsePhenomSearchPage(SMALL);
    expect(page?.totalHits).toBe(2);
    expect(page?.jobs.map((j) => j.jobSeqNo)).toEqual(["ACME001EXTERNAL", "ACME002EXTERNAL"]);
  });

  it("parses the edge fixture (malformed jobs preserved for the builder to drop)", () => {
    const page = parsePhenomSearchPage(EDGE);
    expect(page?.totalHits).toBe(4);
    expect(page?.jobs).toHaveLength(4);
  });

  it("returns null when the page has no eager-load block (e.g. challenge page)", () => {
    expect(parsePhenomSearchPage(NOJSON)).toBeNull();
  });

  it("returns null when the eager-load block is malformed JSON", () => {
    const html =
      '<script>phApp.ddo = {"eagerLoadRefineSearch":{"totalHits": NaNvalue, "data":{}}};</script>';
    expect(parsePhenomSearchPage(html)).toBeNull();
  });

  it("returns null when the eager-load object never closes", () => {
    expect(parsePhenomSearchPage('x "eagerLoadRefineSearch":{ "data": { unterminated')).toBeNull();
  });

  it("returns null when the key is present but no object follows", () => {
    expect(parsePhenomSearchPage('"eagerLoadRefineSearch": null')).toBeNull();
  });

  it("falls back to empty jobs / zero total on non-array, non-number fields", () => {
    const page = parsePhenomSearchPage(
      '<script>x = {"eagerLoadRefineSearch":{"totalHits":"lots","data":{"jobs":"nope"}}};</script>',
    );
    expect(page?.jobs).toEqual([]);
    expect(page?.totalHits).toBe(0);
  });
});

describe("phenomJobToJob", () => {
  it("builds a deep-linked Job with workplace, location, posted_at and department", () => {
    const page = parsePhenomSearchPage(SMALL);
    const job = phenomJobToJob({
      tenant: { slug: "acme", display_name: "Acme Corp" },
      company: "Acme Corp",
      host: HOST,
      locale: LOCALE,
      observedAt: OBSERVED_AT,
      job: page?.jobs[0] ?? {},
    });
    expect(job?.title).toBe("Senior Security Engineer (Remote)");
    expect(job?.source_id).toBe("ACME001EXTERNAL");
    expect(job?.url).toBe(`https://${HOST}/${LOCALE}/job/ACME001EXTERNAL`);
    expect(job?.company).toBe("Acme Corp");
    expect(job?.workplace_type).toBe("remote");
    expect(job?.location_text).toBe("Austin, Texas, United States");
    expect(job?.department).toBe("Security");
    expect(job?.posted_at).toBe("2026-03-12T10:00:00.000Z");
    expect(job?.description_excerpt).toContain("Lead detection engineering");
  });

  it("skips jobs missing jobSeqNo or title", () => {
    const base = {
      tenant: { slug: "acme" },
      company: "Acme",
      host: HOST,
      locale: LOCALE,
      observedAt: OBSERVED_AT,
    };
    expect(phenomJobToJob({ ...base, job: { title: "No Seq" } })).toBeNull();
    expect(phenomJobToJob({ ...base, job: { jobSeqNo: "X1" } })).toBeNull();
    // Whitespace-only title clears the `!j.title` guard but fails JobSchema.
    expect(phenomJobToJob({ ...base, job: { jobSeqNo: "X2", title: "   " } })).toBeNull();
  });

  it("drops a future posted_at and a whitespace teaser; builds location from city/country", () => {
    const page = parsePhenomSearchPage(EDGE);
    const onsite = phenomJobToJob({
      tenant: { slug: "acme" },
      company: "Acme",
      host: HOST,
      locale: LOCALE,
      observedAt: OBSERVED_AT,
      job: page?.jobs.find((j) => j.jobSeqNo === "E3EXTERNAL") ?? {},
    });
    expect(onsite?.workplace_type).toBe("onsite");
    expect(onsite?.posted_at).toBeUndefined();
    expect(onsite?.description_excerpt).toBeUndefined();

    const remote = phenomJobToJob({
      tenant: { slug: "acme" },
      company: "Acme",
      host: HOST,
      locale: LOCALE,
      observedAt: OBSERVED_AT,
      job: page?.jobs.find((j) => j.jobSeqNo === "E4EXTERNAL") ?? {},
    });
    expect(remote?.workplace_type).toBe("remote");
    expect(remote?.location_text).toBe("Remote, United States");
  });
});

describe("parsePhenomSearchPage (property)", () => {
  it("is deterministic on identical input", () => {
    fc.assert(
      fc.property(fc.constantFrom(SMALL, EDGE), (html) => {
        const a = parsePhenomSearchPage(html);
        const b = parsePhenomSearchPage(html);
        return JSON.stringify(a) === JSON.stringify(b);
      }),
      { numRuns: 15 },
    );
  });
});

describe("scrapePhenomTenant", () => {
  it("scrapes a single-page board into deep-linked jobs", async () => {
    server.use(http.get(SEARCH_PATH, () => new HttpResponse(SMALL)));
    const out = await run({ slug: "acme", display_name: "Acme Corp" });
    expect(out.result.status).toBe("success");
    expect(out.result.jobs_count).toBe(2);
    expect(out.jobs.every((j) => j.url.startsWith(`https://${HOST}/${LOCALE}/job/`))).toBe(true);
  });

  it("paginates with ?from until totalHits is reached", async () => {
    const all = Array.from({ length: 12 }, (_, i) => ({
      jobSeqNo: `SEQ${i}EXTERNAL`,
      title: `Role ${i}`,
      location: "Austin, Texas, United States",
      postedDate: "2026-03-01T00:00:00.000+0000",
    }));
    const froms: number[] = [];
    server.use(
      http.get(SEARCH_PATH, ({ request }) => {
        const from = Number.parseInt(new URL(request.url).searchParams.get("from") ?? "0", 10);
        froms.push(from);
        return new HttpResponse(phenomPage(all.slice(from, from + 10), 12));
      }),
    );
    const out = await run({ slug: "acme" });
    expect(out.result.jobs_count).toBe(12);
    expect(froms).toEqual([0, 10]);
  });

  it("returns success with zero jobs when no eager-load block is present", async () => {
    server.use(http.get(SEARCH_PATH, () => new HttpResponse(NOJSON)));
    const out = await run({ slug: "acme" });
    expect(out.result.status).toBe("success");
    expect(out.result.jobs_count).toBe(0);
  });

  it("retries on 5xx then succeeds", async () => {
    let n = 0;
    server.use(
      http.get(SEARCH_PATH, () => {
        n += 1;
        return n < 2 ? new HttpResponse("err", { status: 503 }) : new HttpResponse(SMALL);
      }),
    );
    const out = await run({ slug: "acme" });
    expect(n).toBe(2);
    expect(out.result.status).toBe("success");
  });

  it("marks dead on 404 and transient on exhausted 5xx", async () => {
    server.use(http.get(SEARCH_PATH, () => new HttpResponse("no", { status: 404 })));
    expect((await run({ slug: "acme" })).result.status).toBe("dead");
    server.resetHandlers();
    server.use(http.get(SEARCH_PATH, () => new HttpResponse("err", { status: 502 })));
    expect((await run({ slug: "acme" })).result.status).toBe("transient_failure");
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
    const out = await scrapePhenomTenant({
      tenant: { slug: "acme" },
      client,
      observedAt: OBSERVED_AT,
      host: HOST,
      locale: LOCALE,
    });
    expect(out.result.status).toBe("dead");
    expect(out.result.error).toContain("robots.txt");
  });

  it("returns success with zero jobs when a page has the block but no jobs", async () => {
    server.use(http.get(SEARCH_PATH, () => new HttpResponse(phenomPage([], 5))));
    const out = await run({ slug: "acme" });
    expect(out.result.status).toBe("success");
    expect(out.result.jobs_count).toBe(0);
  });

  it("rejects unsafe hosts (SSRF guard)", async () => {
    for (const host of [
      "169.254.169.254", // metadata IP
      "localhost", // loopback label
      "careers.acme.com/evil", // path injection (hostname mismatch)
      "careers.acme.com@evil.com", // userinfo masking
      "", // unparseable — new URL throws
    ]) {
      const out = await run({ slug: "acme" }, { host });
      expect(out.result.status).toBe("dead");
      expect(out.result.error).toContain("phenom host rejected");
    }
  });

  it("rejects a malformed locale", async () => {
    const out = await run({ slug: "acme" }, { locale: "US/EN/extra" });
    expect(out.result.status).toBe("dead");
    expect(out.result.error).toContain("phenom locale rejected");
  });

  it("rejects an unsafe slug", async () => {
    const out = await run({ slug: "Bad_Slug" });
    expect(out.result.status).toBe("dead");
    expect(out.result.error).toContain("tenant slug rejected");
  });
});
