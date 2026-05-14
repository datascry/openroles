import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import fc from "fast-check";
import {
  assertBrassringIds,
  buildCookieHeader,
  extractRft,
  homeUrlFor,
  jobDetailsUrlFor,
  normalizeBrassringDate,
  parseBrassringJobs,
  scrapeBrassringTenant,
} from "../../src/ats/brassring.ts";
import {
  clientWithRobotsAllowAll,
  HttpResponse,
  http,
  makeServer,
  readFixture,
  readFixtureText,
} from "../helpers.ts";

const OBSERVED_AT = "2026-05-14T00:00:00Z";
const HOME_URL = "https://sjobs.brassring.com/TGNewUI/Search/Home/Home?partnerid=26173&siteid=5197";
const API_URL = "https://sjobs.brassring.com/TgNewUI/Search/Ajax/PowerSearchJobs";

const server = makeServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("normalizeBrassringDate", () => {
  it("parses BrassRing's DD-Mon-YYYY shape to UTC-midnight ISO", () => {
    expect(normalizeBrassringDate("14-May-2026")).toBe("2026-05-14T00:00:00Z");
    expect(normalizeBrassringDate("01-Apr-2026")).toBe("2026-04-01T00:00:00Z");
    expect(normalizeBrassringDate("31-Dec-2025")).toBe("2025-12-31T00:00:00Z");
  });

  it("accepts a single-digit day", () => {
    expect(normalizeBrassringDate("1-Jan-2026")).toBe("2026-01-01T00:00:00Z");
  });

  it("falls back to Date.parse for ISO-shaped inputs", () => {
    const out = normalizeBrassringDate("2026-05-14T10:00:00Z");
    expect(out?.startsWith("2026-05-14")).toBe(true);
  });

  it("returns undefined for unparseable input", () => {
    expect(normalizeBrassringDate("nonsense")).toBeUndefined();
    expect(normalizeBrassringDate("14-Mon-2026")).toBeUndefined();
  });
});

describe("assertBrassringIds", () => {
  it("accepts digit-only ids", () => {
    expect(() => assertBrassringIds("26173", "5197")).not.toThrow();
    expect(() => assertBrassringIds("1", "1")).not.toThrow();
  });

  it("rejects non-numeric ids (template-injection guard)", () => {
    expect(() => assertBrassringIds("publix", "5197")).toThrow();
    expect(() => assertBrassringIds("26173", "5197#alt")).toThrow();
    expect(() => assertBrassringIds("26173&injection=1", "5197")).toThrow();
    expect(() => assertBrassringIds("", "5197")).toThrow();
    expect(() => assertBrassringIds("26173", "")).toThrow();
  });
});

describe("homeUrlFor + jobDetailsUrlFor", () => {
  it("composes the canonical home URL", () => {
    expect(homeUrlFor("26173", "5197")).toBe(HOME_URL);
  });

  it("composes the JobDetails URL with the reqid encoded", () => {
    expect(jobDetailsUrlFor("26173", "5197", "REQ-1001")).toBe(
      "https://sjobs.brassring.com/TGnewUI/Search/home/HomeWithPreLoad?partnerid=26173&siteid=5197&PageType=JobDetails&jobid=REQ-1001",
    );
    // Special chars in reqid get percent-encoded.
    expect(jobDetailsUrlFor("26173", "5197", "with space")).toContain("jobid=with%20space");
  });
});

describe("extractRft", () => {
  it("returns the token from the hidden form input", () => {
    const html = readFixtureText("brassring.home.html");
    expect(extractRft(html)).toBe("d5avbK0hvx8teGFoPtP9Q1y1ZFmXJHTESTTOKEN0123456789abcdef");
  });

  it("returns null when no __RequestVerificationToken is present", () => {
    expect(extractRft("<html><body>no token</body></html>")).toBeNull();
  });

  it("never throws on arbitrary input", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const out = extractRft(s);
        return out === null || typeof out === "string";
      }),
      { numRuns: 100 },
    );
  });
});

describe("buildCookieHeader", () => {
  it("keeps the name=value prefix and drops attribute fragments", () => {
    expect(
      buildCookieHeader([
        "ASP.NET_SessionId=abc123; path=/; HttpOnly",
        "RFT_COOKIE=def456; secure; samesite=lax",
      ]),
    ).toBe("ASP.NET_SessionId=abc123; RFT_COOKIE=def456");
  });

  it("handles a Set-Cookie with no attributes", () => {
    expect(buildCookieHeader(["foo=bar"])).toBe("foo=bar");
  });

  it("returns an empty string for an empty input", () => {
    expect(buildCookieHeader([])).toBe("");
  });

  it("preserves the order of cookies as provided", () => {
    expect(buildCookieHeader(["a=1; HttpOnly", "b=2; Secure", "c=3"])).toBe("a=1; b=2; c=3");
  });
});

describe("parseBrassringJobs (fixture replay)", () => {
  it("parses the small synthetic fixture (3 jobs)", () => {
    const json = readFixture("brassring.small.json");
    const out = parseBrassringJobs({
      tenant: { slug: "publix", display_name: "Publix Super Markets" },
      company: "Publix Super Markets",
      partnerId: "26173",
      siteId: "5197",
      response: json,
      observedAt: OBSERVED_AT,
    });
    expect(out).toHaveLength(3);
    const titles = out.map((j) => j.title).sort();
    expect(titles).toEqual([
      "Pharmacy Technician",
      "Senior Software Engineer",
      "Talent Acquisition Partner",
    ]);
    const eng = out.find((j) => j.source_id === "REQ-1001");
    expect(eng?.location_text).toBe("Austin, TX");
    expect(eng?.posted_at).toBe("2026-04-01T00:00:00Z");
    // The job's `Link` field is preserved when same-host (SSRF guard).
    expect(eng?.url).toBe(
      "https://sjobs.brassring.com/TGnewUI/Search/home/HomeWithPreLoad?partnerid=26173&siteid=5197&PageType=JobDetails&jobid=REQ-1001",
    );
    // Job without Link falls back to a synthesised JobDetails URL.
    const rec = out.find((j) => j.source_id === "REQ-1002");
    expect(rec?.url).toContain("jobid=REQ-1002");
    // The recruiter title gets flagged.
    expect(rec?.is_recruiter_post).toBe(true);
    // Remote location heuristic via workplace_hint.
    const phar = out.find((j) => j.source_id === "REQ-1003");
    expect(phar?.workplace_type).toBe("remote");
  });

  it("parses the real Publix capture (3 trimmed jobs)", () => {
    const json = readFixture("brassring.publix-real.json");
    const out = parseBrassringJobs({
      tenant: { slug: "publix", display_name: "Publix Super Markets" },
      company: "Publix Super Markets",
      partnerId: "26173",
      siteId: "5197",
      response: json,
      observedAt: OBSERVED_AT,
    });
    expect(out.length).toBeGreaterThan(0);
    const first = out[0];
    expect(first?.ats).toBe("brassring");
    expect(first?.tenant_slug).toBe("publix");
    // Spot-check the real first row from the capture (reqid 1396369).
    const lineWorker = out.find((j) => j.source_id === "1396369");
    expect(lineWorker?.title).toBe("Line Worker, AM, Fresh Kitchen - Deerfield");
    expect(lineWorker?.location_text).toBe("Deerfield Beach, FL");
    expect(lineWorker?.posted_at?.startsWith("2026-05-14")).toBe(true);
  });

  it("returns [] for an empty Job array", () => {
    const json = readFixture("brassring.empty.json");
    const out = parseBrassringJobs({
      tenant: { slug: "x" },
      company: "X",
      partnerId: "26173",
      siteId: "5197",
      response: json,
      observedAt: OBSERVED_AT,
    });
    expect(out).toEqual([]);
  });

  it("skips records missing reqid or jobtitle", () => {
    const response = {
      Jobs: {
        Job: [
          { Questions: [{ QuestionName: "reqid", Value: "X1" }] }, // no jobtitle
          { Questions: [{ QuestionName: "jobtitle", Value: "Y" }] }, // no reqid
          {
            Questions: [
              { QuestionName: "reqid", Value: "Z1" },
              { QuestionName: "jobtitle", Value: "Good Title" },
            ],
          },
        ],
      },
      JobsCount: 3,
    };
    const out = parseBrassringJobs({
      tenant: { slug: "x" },
      company: "X",
      partnerId: "26173",
      siteId: "5197",
      response,
      observedAt: OBSERVED_AT,
    });
    expect(out).toHaveLength(1);
    expect(out[0]?.title).toBe("Good Title");
  });

  it("rejects a Link field that points off-host (SSRF guard)", () => {
    const response = {
      Jobs: {
        Job: [
          {
            Questions: [
              { QuestionName: "reqid", Value: "1" },
              { QuestionName: "jobtitle", Value: "Hostile" },
            ],
            Link: "https://attacker.com/?ohno",
          },
        ],
      },
      JobsCount: 1,
    };
    const out = parseBrassringJobs({
      tenant: { slug: "x" },
      company: "X",
      partnerId: "26173",
      siteId: "5197",
      response,
      observedAt: OBSERVED_AT,
    });
    // Falls back to the safe synthesised JobDetails URL.
    expect(out[0]?.url).toContain("sjobs.brassring.com");
    expect(out[0]?.url).not.toContain("attacker.com");
  });
});

describe("parseBrassringJobs (property)", () => {
  it("never throws on arbitrary HTML-derived strings as Question values", () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (titleVal, locationVal) => {
        const response = {
          Jobs: {
            Job: [
              {
                Questions: [
                  { QuestionName: "reqid", Value: "1" },
                  { QuestionName: "jobtitle", Value: titleVal },
                  { QuestionName: "location", Value: locationVal },
                ],
              },
            ],
          },
        };
        const out = parseBrassringJobs({
          tenant: { slug: "x" },
          company: "X",
          partnerId: "26173",
          siteId: "5197",
          response,
          observedAt: OBSERVED_AT,
        });
        return Array.isArray(out);
      }),
      { numRuns: 100 },
    );
  });

  it("is deterministic on identical input", () => {
    const json = readFixture("brassring.small.json");
    fc.assert(
      fc.property(fc.constantFrom("publix", "lockheed"), (slug) => {
        const a = parseBrassringJobs({
          tenant: { slug },
          company: slug,
          partnerId: "26173",
          siteId: "5197",
          response: json,
          observedAt: OBSERVED_AT,
        });
        const b = parseBrassringJobs({
          tenant: { slug },
          company: slug,
          partnerId: "26173",
          siteId: "5197",
          response: json,
          observedAt: OBSERVED_AT,
        });
        return JSON.stringify(a) === JSON.stringify(b);
      }),
      { numRuns: 20 },
    );
  });
});

describe("scrapeBrassringTenant", () => {
  it("walks the home → API two-step and returns the parsed jobs", async () => {
    server.use(
      http.get(HOME_URL, () =>
        HttpResponse.html(readFixtureText("brassring.home.html"), {
          headers: {
            "Set-Cookie": [
              "ASP.NET_SessionId=abc123; path=/; HttpOnly",
              "RFT_COOKIE=def456; secure",
            ],
          },
        }),
      ),
      http.post(API_URL, () => HttpResponse.json(readFixture("brassring.small.json"))),
    );
    const out = await scrapeBrassringTenant({
      tenant: { slug: "publix", display_name: "Publix Super Markets" },
      client: clientWithRobotsAllowAll(),
      observedAt: OBSERVED_AT,
      partnerId: "26173",
      siteId: "5197",
    });
    expect(out.jobs).toHaveLength(3);
    expect(out.result.status).toBe("success");
    expect(out.result.jobs_count).toBe(3);
  });

  it("transient_failure when the home page lacks an RFT token", async () => {
    server.use(
      http.get(HOME_URL, () =>
        HttpResponse.html("<html><body>no token</body></html>", { status: 200 }),
      ),
    );
    const out = await scrapeBrassringTenant({
      tenant: { slug: "publix" },
      client: clientWithRobotsAllowAll(),
      observedAt: OBSERVED_AT,
      partnerId: "26173",
      siteId: "5197",
    });
    expect(out.jobs).toHaveLength(0);
    expect(out.result.status).toBe("transient_failure");
    expect(out.result.error).toContain("RequestVerificationToken");
  });

  it("rejects malformed partnerid before any HTTP fires", async () => {
    const out = await scrapeBrassringTenant({
      tenant: { slug: "publix" },
      client: clientWithRobotsAllowAll(),
      observedAt: OBSERVED_AT,
      partnerId: "26173 OR 1=1",
      siteId: "5197",
    });
    expect(out.jobs).toHaveLength(0);
    expect(out.result.status).toBe("dead");
  });

  it("rejects an unsafe tenant slug before any HTTP fires", async () => {
    const out = await scrapeBrassringTenant({
      tenant: { slug: "../etc/passwd" },
      client: clientWithRobotsAllowAll(),
      observedAt: OBSERVED_AT,
      partnerId: "26173",
      siteId: "5197",
    });
    expect(out.jobs).toHaveLength(0);
    expect(out.result.status).toBe("dead");
  });

  it("stops paginating when a page returns fewer than PAGE_SIZE jobs", async () => {
    // First call returns RFT-token home. Second call (API) returns 3
    // jobs (< 50). The scraper must NOT request page 2.
    let apiCallCount = 0;
    server.use(
      http.get(HOME_URL, () => HttpResponse.html(readFixtureText("brassring.home.html"))),
      http.post(API_URL, async ({ request }) => {
        apiCallCount += 1;
        // Sanity: confirm the RFT header + cookie were attached.
        expect(request.headers.get("rft")).toBeTruthy();
        return HttpResponse.json(readFixture("brassring.small.json"));
      }),
    );
    const out = await scrapeBrassringTenant({
      tenant: { slug: "publix" },
      client: clientWithRobotsAllowAll(),
      observedAt: OBSERVED_AT,
      partnerId: "26173",
      siteId: "5197",
    });
    expect(out.jobs).toHaveLength(3);
    expect(apiCallCount).toBe(1);
  });
});
