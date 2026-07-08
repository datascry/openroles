import { afterAll, afterEach, beforeAll, describe, expect, it, mock } from "bun:test";
import type { TenantInput } from "@openroles/shared";
import fc from "fast-check";
import {
  normalizeTalentbrewDate,
  parseTalentbrewPage,
  scrapeTalentbrewTenant,
  stripTalentbrewTitle,
} from "../../src/ats/talentbrew.ts";
import { HttpClient } from "../../src/http.ts";
import { RobotsTxtCache } from "../../src/robots.ts";
import {
  clientWithRobotsAllowAll,
  HttpResponse,
  http,
  makeServer,
  readFixtureText,
} from "../helpers.ts";

// observedAt sits at noon on the latest fixture date so both fixture post
// dates (2026-07-07 and 2026-07-08, normalised to UTC midnight) clamp in.
const OBSERVED_AT = "2026-07-08T12:00:00.000Z";
const HOST = "jobs.example.com";
const SEARCH_URL = `https://${HOST}/search-jobs`;

const DISNEY = readFixtureText("talentbrew.disney.html");
const BOEING = readFixtureText("talentbrew.boeing.html");
const COMCAST = readFixtureText("talentbrew.comcast.html");
const EMPTY = readFixtureText("talentbrew.empty.html");

const server = makeServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function parse(
  html: string,
  tenant: TenantInput = { slug: "acme", display_name: "Acme" },
  host = HOST,
) {
  return parseTalentbrewPage({
    tenant,
    company: tenant.display_name ?? tenant.slug,
    host,
    html,
    observedAt: OBSERVED_AT,
  });
}

function run(
  tenant: TenantInput,
  opts: { host?: string; maxPages?: number } = {},
): ReturnType<typeof scrapeTalentbrewTenant> {
  return scrapeTalentbrewTenant({
    tenant,
    client: clientWithRobotsAllowAll(),
    observedAt: OBSERVED_AT,
    host: opts.host ?? HOST,
    ...(opts.maxPages !== undefined ? { maxPages: opts.maxPages } : {}),
  });
}

// Minimal skin-A page (table / h2) with distinct ids per page — used to drive
// the pagination, dedupe, total-reached and cap branches deterministically.
function tbPage(ids: number[], total: number): string {
  const rows = ids
    .map(
      (id) =>
        `<tr><td><a href="/job/testville/role-${id}/1/${id}" data-job-id="${id}">` +
        `<h2>Role ${id}</h2></a></td>` +
        `<td><span class="job-location">Testville, TS</span></td>` +
        `<td><span class="job-date-posted">Jul. 01, 2026</span></td></tr>`,
    )
    .join("");
  return `<section data-total-results="${total}"><table><tbody>${rows}</tbody></table></section>`;
}

describe("parseTalentbrewPage (fixture replay)", () => {
  it("parses the table/h2 skin (Disney): title, id, apply URL, columns", () => {
    const page = parse(DISNEY);
    expect(page.total).toBe(757);
    expect(page.anchorCount).toBe(3);
    expect(page.jobs).toHaveLength(3);

    const laundry = page.jobs.find((j) => j.source_id === "97531005888");
    expect(laundry?.title).toBe("Laundry Helper - Full Time/Part Time, Walt Disney World");
    expect(laundry?.url).toBe(
      `https://${HOST}/job/orlando/laundry-helper-full-time-part-time-walt-disney-world/391/97531005888`,
    );
    // Doubled whitespace in the cell collapses; the slash-joined dual location
    // is kept verbatim.
    expect(laundry?.location_text).toBe(
      "Orlando, Florida, United States / Lake Buena Vista, Florida, United States",
    );
    // "Jul. 07, 2026" → ISO.
    expect(laundry?.posted_at).toBe("2026-07-07T00:00:00.000Z");
    // The job-brand column maps into department.
    expect(laundry?.department).toBe("Walt Disney World Resort");
    expect(new Set(page.jobs.map((j) => j.id)).size).toBe(page.jobs.length);
  });

  it("parses the list/span skin (Boeing): entity-decoded title, MM/DD/YYYY date, no brand", () => {
    const page = parse(BOEING);
    expect(page.total).toBe(1378);
    expect(page.jobs).toHaveLength(3);

    const mro = page.jobs.find((j) => j.source_id === "97531445088");
    // `&amp;` decodes to `&`; the title comes from the job-title span.
    expect(mro?.title).toBe("Maintenance, Modification, Repair & Overhaul Senior Manager");
    expect(mro?.location_text).toBe("Amberley, Australia");
    // "07/08/2026" → ISO.
    expect(mro?.posted_at).toBe("2026-07-08T00:00:00.000Z");
    // This skin renders no brand column → department omitted.
    expect(mro?.department).toBeUndefined();
  });

  it("parses the ul/li skin (Comcast) where columns nest inside the anchor", () => {
    const page = parse(COMCAST);
    expect(page.total).toBe(858);
    expect(page.jobs).toHaveLength(3);

    const eng = page.jobs.find((j) => j.source_id === "95390508400");
    // The title is the <h2> only — the nested facet-group (location, category,
    // date) must NOT leak into the title.
    expect(eng?.title).toBe("CEUI Assisted Tools Engineer");
    expect(eng?.location_text).toBe("Philadelphia, PA");
    expect(eng?.posted_at).toBe("2026-07-08T00:00:00.000Z");
    expect(eng?.department).toBeUndefined();
  });

  it("returns zero rows for a past-the-end page", () => {
    const page = parse(EMPTY);
    expect(page.anchorCount).toBe(0);
    expect(page.jobs).toHaveLength(0);
    // The marker is still present on an empty page.
    expect(page.total).toBe(757);
  });

  it("ignores an <a> that carries a /job href but no data-job-id", () => {
    const html =
      '<section data-total-results="1">' +
      '<a href="/job/x/role/1/123"><h2>No Id</h2></a>' +
      '<a href="/job/x/role/1/456" data-job-id="456"><h2>Has Id</h2></a>' +
      "</section>";
    const page = parse(html);
    expect(page.anchorCount).toBe(1);
    expect(page.jobs.map((j) => j.source_id)).toEqual(["456"]);
  });

  it("skips a row whose title strips to empty", () => {
    const html =
      '<section><a href="/job/x/r/1/1" data-job-id="1"><h2></h2></a>' +
      '<a href="/job/x/r/1/2" data-job-id="2"><h2>Real</h2></a></section>';
    const page = parse(html);
    expect(page.jobs.map((j) => j.source_id)).toEqual(["2"]);
  });

  it("dedupes repeated ids within a page and omits absent columns", () => {
    const html =
      '<section><a href="/job/x/r/1/7" data-job-id="7"><h2>One</h2></a>' +
      '<a href="/job/x/r/1/7" data-job-id="7"><h2>One again</h2></a></section>';
    const page = parse(html);
    expect(page.anchorCount).toBe(2);
    expect(page.jobs).toHaveLength(1);
    expect(page.jobs[0]?.location_text).toBeUndefined();
    expect(page.jobs[0]?.posted_at).toBeUndefined();
    expect(page.jobs[0]?.department).toBeUndefined();
  });

  it("reads location and date columns that carry extra trailing classes", () => {
    const html =
      '<section><tr><td><a href="/job/x/r/1/9" data-job-id="9"><h2>Nine</h2></a></td>' +
      '<td><span class="job-location is-remote">Austin, TX</span></td>' +
      '<td><span class="job-date-posted highlight">Jul. 03, 2026</span></td></tr></section>';
    const page = parse(html);
    expect(page.jobs[0]?.location_text).toBe("Austin, TX");
    expect(page.jobs[0]?.posted_at).toBe("2026-07-03T00:00:00.000Z");
  });

  it("omits an unparseable or future posted date rather than throwing", () => {
    const html =
      '<section><a href="/job/x/r/1/1" data-job-id="1"><h2>Bad date</h2></a>' +
      '<span class="job-date-posted">Never</span>' +
      '<a href="/job/x/r/1/2" data-job-id="2"><h2>Future</h2></a>' +
      '<span class="job-date-posted">Jul. 07, 2099</span></section>';
    const page = parse(html);
    expect(page.jobs.find((j) => j.source_id === "1")?.posted_at).toBeUndefined();
    expect(page.jobs.find((j) => j.source_id === "2")?.posted_at).toBeUndefined();
  });
});

describe("normalizeTalentbrewDate", () => {
  const FAR = "2999-01-01T00:00:00.000Z";
  it("parses both skins' date formats to UTC-midnight ISO", () => {
    expect(normalizeTalentbrewDate("Jul. 07, 2026", FAR)).toBe("2026-07-07T00:00:00.000Z");
    // A month abbreviation without the trailing period is accepted too.
    expect(normalizeTalentbrewDate("Mar 3, 2026", FAR)).toBe("2026-03-03T00:00:00.000Z");
    expect(normalizeTalentbrewDate("07/08/2026", FAR)).toBe("2026-07-08T00:00:00.000Z");
    expect(normalizeTalentbrewDate("7/8/2026", FAR)).toBe("2026-07-08T00:00:00.000Z");
  });

  it("returns undefined for undefined, malformed, and impossible dates", () => {
    expect(normalizeTalentbrewDate(undefined, FAR)).toBeUndefined();
    expect(normalizeTalentbrewDate("", FAR)).toBeUndefined();
    expect(normalizeTalentbrewDate("Never", FAR)).toBeUndefined();
    expect(normalizeTalentbrewDate("Foo. 07, 2026", FAR)).toBeUndefined(); // bad month name
    expect(normalizeTalentbrewDate("13/40/2026", FAR)).toBeUndefined(); // impossible m/d
    expect(normalizeTalentbrewDate("Feb. 30, 2026", FAR)).toBeUndefined(); // rolls over
  });

  it("drops a date in the future of the observation", () => {
    expect(normalizeTalentbrewDate("07/08/2026", "2026-07-01T00:00:00.000Z")).toBeUndefined();
  });
});

describe("normalizeTalentbrewDate (property)", () => {
  const FAR = "2999-01-01T00:00:00.000Z";
  const iso = /^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/;

  it("both formats of the same valid date round-trip to the same ISO", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1990, max: 2098 }),
        fc.integer({ min: 1, max: 12 }),
        fc.integer({ min: 1, max: 28 }), // ≤28 is valid in every month
        (y, m, d) => {
          const mm = String(m).padStart(2, "0");
          const dd = String(d).padStart(2, "0");
          const abbr = [
            "Jan",
            "Feb",
            "Mar",
            "Apr",
            "May",
            "Jun",
            "Jul",
            "Aug",
            "Sep",
            "Oct",
            "Nov",
            "Dec",
          ][m - 1];
          const worded = normalizeTalentbrewDate(`${abbr}. ${d}, ${y}`, FAR);
          const numeric = normalizeTalentbrewDate(`${mm}/${dd}/${y}`, FAR);
          return worded === `${y}-${mm}-${dd}T00:00:00.000Z` && worded === numeric;
        },
      ),
      { numRuns: 40 },
    );
  });

  it("never throws and only ever returns a well-formed ISO or undefined", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const out = normalizeTalentbrewDate(s, FAR);
        return out === undefined || iso.test(out);
      }),
      { numRuns: 60 },
    );
  });
});

describe("stripTalentbrewTitle", () => {
  it("reads the title from the <h2> wrapper, ignoring nested siblings", () => {
    expect(
      stripTalentbrewTitle('<h2>CEUI Engineer</h2><div class="facet-group">Philadelphia</div>'),
    ).toBe("CEUI Engineer");
  });

  it("reads the title from the job-title span and decodes entities", () => {
    expect(
      stripTalentbrewTitle('<span class="search-results__job-title">R &amp; D Lead</span>'),
    ).toBe("R & D Lead");
  });

  it("falls back to the full inner text when no title wrapper is present", () => {
    expect(stripTalentbrewTitle("Plain Title")).toBe("Plain Title");
  });

  it("(property) never throws and never returns markup for tag-shaped input", () => {
    const token = fc.constantFrom(
      "<h2>",
      "</h2>",
      "<span>",
      "</span>",
      "<div>",
      "</div>",
      "Role",
      " ",
      "&amp;",
      "Manager",
    );
    fc.assert(
      fc.property(fc.array(token), (parts) => {
        const out = stripTalentbrewTitle(parts.join(""));
        return typeof out === "string" && !/<\/?(?:h2|span|div|a)\b/i.test(out);
      }),
      { numRuns: 60 },
    );
  });
});

describe("scrapeTalentbrewTenant", () => {
  it("walks pages until an empty page ends the board", async () => {
    const requests: string[] = [];
    server.use(
      http.get(SEARCH_URL, ({ request }) => {
        requests.push(request.url);
        const p = new URL(request.url).searchParams.get("p");
        return new HttpResponse(p === "1" ? DISNEY : EMPTY);
      }),
    );
    const out = await run({ slug: "acme", display_name: "Acme" });
    expect(out.result.status).toBe("success");
    expect(out.result.http_status).toBe(200);
    expect(out.result.jobs_count).toBe(3);
    expect(out.result.error).toBeUndefined();
    expect(requests).toHaveLength(2);
    expect(requests[0]).toContain("p=1");
    expect(requests[1]).toContain("p=2");
    expect(out.jobs.every((j) => j.url.startsWith(`https://${HOST}/job/`))).toBe(true);
  });

  it("stops once the collected count reaches data-total-results and dedupes overlap", async () => {
    const requests: string[] = [];
    server.use(
      http.get(SEARCH_URL, ({ request }) => {
        requests.push(request.url);
        const p = new URL(request.url).searchParams.get("p");
        // total = 4; page 1 has 1,2,3 and page 2 repeats 3 then adds 4.
        return new HttpResponse(p === "1" ? tbPage([1, 2, 3], 4) : tbPage([3, 4], 4));
      }),
    );
    const out = await run({ slug: "acme" });
    expect(out.result.status).toBe("success");
    expect(out.result.jobs_count).toBe(4); // deduped across pages
    expect(requests).toHaveLength(2); // stopped at total, no page 3
  });

  it("caps at MAX_PAGES and reports the truncation", async () => {
    const requests: string[] = [];
    server.use(
      http.get(SEARCH_URL, ({ request }) => {
        requests.push(request.url);
        const p = Number(new URL(request.url).searchParams.get("p"));
        // Every page is full and the total is never reached, so only the cap
        // halts the walk.
        return new HttpResponse(tbPage([p * 10 + 1, p * 10 + 2], 9999));
      }),
    );
    const out = await run({ slug: "acme" }, { maxPages: 2 });
    expect(out.result.status).toBe("success");
    expect(out.result.jobs_count).toBe(4); // 2 pages × 2 roles
    expect(out.result.error).toContain("capped");
    expect(requests).toHaveLength(2);
  });

  it("returns success with zero jobs for an immediately empty board", async () => {
    server.use(http.get(SEARCH_URL, () => new HttpResponse(EMPTY)));
    const out = await run({ slug: "acme" });
    expect(out.result.status).toBe("success");
    expect(out.result.jobs_count).toBe(0);
  });

  it("marks dead on 404 and transient on exhausted 5xx", async () => {
    server.use(http.get(SEARCH_URL, () => new HttpResponse("no", { status: 404 })));
    expect((await run({ slug: "acme" })).result.status).toBe("dead");
    server.resetHandlers();
    server.use(http.get(SEARCH_URL, () => new HttpResponse("err", { status: 502 })));
    expect((await run({ slug: "acme" })).result.status).toBe("transient_failure");
  });

  it("rejects unsafe hosts (SSRF guard)", async () => {
    for (const host of [
      "169.254.169.254", // metadata IP
      "localhost", // loopback label
      "jobs.acme.com/evil", // path injection (hostname mismatch)
      "jobs.acme.com@evil.com", // userinfo masking
      "", // unparseable — new URL throws
    ]) {
      const out = await run({ slug: "acme" }, { host });
      expect(out.result.status).toBe("dead");
      expect(out.result.error).toContain("talentbrew host rejected");
    }
  });

  it("marks the tenant dead on an unsafe slug", async () => {
    const out = await run({ slug: "Bad_Slug" });
    expect(out.result.status).toBe("dead");
    expect(out.result.error).toContain("tenant slug rejected");
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
    const out = await scrapeTalentbrewTenant({
      tenant: { slug: "acme" },
      client,
      observedAt: OBSERVED_AT,
      host: HOST,
    });
    expect(out.result.status).toBe("dead");
    expect(out.result.error).toContain("robots.txt");
  });
});
