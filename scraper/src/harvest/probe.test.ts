import { afterEach, describe, expect, it, mock } from "bun:test";
import { HttpClient } from "../http.ts";
import { RobotsTxtCache } from "../robots.ts";
import { probeMany, probeOne, probeUrlFor, probeUrlForWithMetadata } from "./probe.ts";
import { urlHostIs } from "./test-helpers.ts";

const OBSERVED_AT = "2026-04-26T00:00:00Z";

afterEach(() => mock.restore());

const ROBOTS_OK = new RobotsTxtCache({
  fetchFn: async () => new Response("", { status: 404 }),
  clock: () => 0,
});

function clientWith(fetchFn: typeof globalThis.fetch): HttpClient {
  return new HttpClient({
    userAgent: "openroles/0.0.0 (+https://example.com)",
    robots: ROBOTS_OK,
    fetchFn,
    sleep: async () => {},
    random: () => 0.5,
    retry: { maxAttempts: 1, baseMs: 1, maxMs: 1 },
  });
}

describe("probeUrlFor", () => {
  it("emits the canonical probe URL per ATS", () => {
    expect(probeUrlFor("greenhouse", "stripe")).toContain("/boards/stripe/jobs");
    expect(probeUrlFor("lever", "stripe")).toContain("/v0/postings/stripe");
    expect(probeUrlFor("ashby", "stripe")).toContain("/posting-api/job-board/stripe");
    expect(probeUrlFor("bamboohr", "stripe")).toContain("stripe.bamboohr.com");
    // iCIMS slug is the full subdomain label — most real tenants don't use
    // a `careers-` prefix, so the probe URL composes `{slug}.icims.com`.
    expect(probeUrlFor("icims", "careers-stripe")).toContain("careers-stripe.icims.com");
    expect(probeUrlFor("icims", "1stheritage-attainfinance")).toContain(
      "1stheritage-attainfinance.icims.com",
    );
    expect(probeUrlFor("recruitee", "stripe")).toContain("stripe.recruitee.com/api/offers");
    expect(probeUrlFor("breezy", "stripe")).toContain("stripe.breezy.hr/json");
    expect(probeUrlFor("personio", "stripe")).toContain("stripe.jobs.personio.com/xml");
    expect(probeUrlFor("workable", "stripe")).toContain(
      "apply.workable.com/api/v1/widget/accounts/stripe",
    );
    expect(probeUrlFor("teamtailor", "stripe")).toContain("stripe.teamtailor.com/jobs.rss");
    expect(probeUrlFor("smartrecruiters", "stripe")).toContain(
      "api.smartrecruiters.com/v1/companies/stripe/postings",
    );
    expect(probeUrlFor("csod", "stripe")).toBe("https://stripe.csod.com/");
    expect(probeUrlFor("taleo", "aa067")).toBe("https://aa067.taleo.net/careersection/");
    expect(probeUrlFor("jobvite", "stripe")).toBe("https://jobs.jobvite.com/stripe");
    expect(probeUrlFor("zohorecruit", "stripe")).toContain("stripe.zohorecruit.com/jobs/Careers");
    expect(probeUrlFor("talentlyft", "stripe")).toBe("https://stripe.talentlyft.com/");
    expect(probeUrlFor("pinpointhq", "stripe")).toBe("https://stripe.pinpointhq.com/");
    expect(probeUrlFor("applicantpro", "stripe")).toBe("https://stripe.applicantpro.com/jobs/");
    expect(probeUrlFor("applicantstack", "stripe")).toBe("https://stripe.applicantstack.com/");
    expect(probeUrlFor("homerun", "stripe")).toBe("https://feed.homerun.co/stripe");
    expect(probeUrlFor("factorial", "stripe")).toBe("https://stripe.factorialhr.com/sitemap.xml");
    expect(probeUrlFor("eightfold", "stripe")).toBe(
      "https://stripe.eightfold.ai/careers/sitemap.xml",
    );
    // Phase-6 custom ATSes — single-tenant, slug ignored. Probe URL is
    // the GET-friendly public landing page (not the POST-only API the
    // scraper hits).
    expect(probeUrlFor("amazonjobs", "amazon")).toBe(
      "https://amazon.jobs/en/search.json?result_limit=1",
    );
    expect(probeUrlFor("applejobs", "apple")).toBe("https://jobs.apple.com/");
    expect(probeUrlFor("tiktokcareers", "tiktok")).toBe("https://careers.tiktok.com/");
    expect(probeUrlFor("metacareers", "meta")).toBe("https://www.metacareers.com/jobs/");
    // Subdomain-per-tenant boards: the public listing page is the probe.
    expect(probeUrlFor("jazzhr", "stripe")).toBe("https://stripe.applytojob.com/apply/");
    expect(probeUrlFor("hrmdirect", "stripe")).toBe(
      "https://stripe.hrmdirect.com/employment/job-openings.php",
    );
    // hiringthing probes the per-board RSS feed (200 even on an empty board).
    expect(probeUrlFor("hiringthing", "stripe")).toBe("https://stripe.hiringthing.com/api/rss.xml");
  });

  it("throws for ATSes with no probe URL configured (defensive)", () => {
    // workday and ultipro both compose URLs from a (tenant_code + GUID) pair
    // we can't derive from the slug alone — they are intentionally absent.
    expect(() => probeUrlFor("workday", "stripe")).toThrow();
    expect(() => probeUrlFor("ultipro", "ABC1002XYZ")).toThrow();
  });
});

describe("probeUrlForWithMetadata", () => {
  it("returns undefined for ATSes with no composite-metadata builder", () => {
    expect(probeUrlForWithMetadata("greenhouse", "stripe", { host: "x" })).toBeUndefined();
  });

  it("composes the oraclecloud requisitions URL from host + site", () => {
    expect(
      probeUrlForWithMetadata("oraclecloud", "acme", {
        host: "acme.fa.us2.oraclecloud.com",
        site: "CX_1001",
      }),
    ).toBe(
      "https://acme.fa.us2.oraclecloud.com/hcmRestApi/resources/latest/recruitingCEJobRequisitions?onlyData=true&expand=requisitionList&finder=findReqs;siteNumber=CX_1001,limit=1,sortBy=POSTING_DATES_DESC",
    );
  });

  it("rejects oraclecloud with a missing site or an SSRF/injection host", () => {
    // No site → can't address the candidate-experience site.
    expect(
      probeUrlForWithMetadata("oraclecloud", "acme", { host: "acme.fa.us2.oraclecloud.com" }),
    ).toBeUndefined();
    // Host outside the *.fa.*.oraclecloud.com shape → assertOracleHost rejects.
    expect(
      probeUrlForWithMetadata("oraclecloud", "acme", {
        host: "evil.example.com",
        site: "CX_1001",
      }),
    ).toBeUndefined();
    // Site with URL-breaking characters → assertOracleSite rejects.
    expect(
      probeUrlForWithMetadata("oraclecloud", "acme", {
        host: "acme.fa.us2.oraclecloud.com",
        site: "CX_1001;limit=999",
      }),
    ).toBeUndefined();
  });

  it("composes the phenom search-results URL and defaults locale to us/en", () => {
    expect(probeUrlForWithMetadata("phenom", "acme", { host: "careers.acme.com" })).toBe(
      "https://careers.acme.com/us/en/search-results",
    );
    expect(
      probeUrlForWithMetadata("phenom", "acme", { host: "careers.acme.com", locale: "uk/en" }),
    ).toBe("https://careers.acme.com/uk/en/search-results");
  });

  it("rejects phenom with a malformed locale or an unsafe host", () => {
    // Locale must be `{country}/{lang}`; an underscore form is rejected.
    expect(
      probeUrlForWithMetadata("phenom", "acme", { host: "careers.acme.com", locale: "EN_US" }),
    ).toBeUndefined();
    // Bare IPv4 literal fails the hostname regex.
    expect(probeUrlForWithMetadata("phenom", "acme", { host: "169.254.169.254" })).toBeUndefined();
    // Regex-valid but SSRF-unsafe (`.internal`) → isSafeFetchHost rejects.
    expect(
      probeUrlForWithMetadata("phenom", "acme", { host: "careers.acme.internal" }),
    ).toBeUndefined();
  });
});

describe("probeOne", () => {
  it("classifies a 200 response as live", async () => {
    const fetchFn = mock(async () => new Response("[]", { status: 200 }));
    const t = await probeOne("greenhouse", "stripe", clientWith(fetchFn), OBSERVED_AT);
    expect(t.status).toBe("live");
  });

  it("probes jazzhr with redirect:manual and classifies a direct 200 as live", async () => {
    let seenRedirect: string | undefined;
    const fetchFn = mock(async (_input: Request | string, init?: RequestInit) => {
      seenRedirect = init?.redirect;
      return new Response("<html>career page</html>", { status: 200 });
    });
    const t = await probeOne("jazzhr", "10xhealthsystem", clientWith(fetchFn), OBSERVED_AT);
    expect(t.status).toBe("live");
    // Must NOT follow redirects, otherwise a dead board's cross-host 302 to a
    // generic landing page would be followed into a 200 and look live.
    expect(seenRedirect).toBe("manual");
  });

  it("classifies a jazzhr 3xx (cross-host redirect to generic page) as dead", async () => {
    // A nonexistent applytojob.com subdomain 302-redirects to the vendor's
    // generic job-seekers page; treat that redirect itself as the dead signal.
    const fetchFn = mock(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://info.example.com/job-seekers.html" },
        }),
    );
    const t = await probeOne("jazzhr", "no-such-tenant", clientWith(fetchFn), OBSERVED_AT);
    expect(t.status).toBe("dead");
  });

  it("probes hrmdirect with redirect:manual and classifies a direct 200 as live", async () => {
    let seenRedirect: string | undefined;
    const fetchFn = mock(async (_input: Request | string, init?: RequestInit) => {
      seenRedirect = init?.redirect;
      return new Response("<table>jobs</table>", { status: 200 });
    });
    const t = await probeOne("hrmdirect", "energysystemsgroup", clientWith(fetchFn), OBSERVED_AT);
    expect(t.status).toBe("live");
    expect(seenRedirect).toBe("manual");
  });

  it("classifies an hrmdirect same-host 3xx (self URL-normalization) as live", async () => {
    // A live hrmdirect board 302-redirects its listing to itself with a
    // default category sort appended (`?cust_sort1=NNNNNN`). That same-host
    // redirect must NOT be read as dead — only a cross-host bounce is dead.
    const fetchFn = mock(
      async () =>
        new Response(null, {
          status: 302,
          headers: {
            location:
              "https://energysystemsgroup.hrmdirect.com/employment/job-openings.php?cust_sort1=123456",
          },
        }),
    );
    const t = await probeOne("hrmdirect", "energysystemsgroup", clientWith(fetchFn), OBSERVED_AT);
    expect(t.status).toBe("live");
  });

  it("treats a 3xx with no Location header as live, not dead", async () => {
    // Defensive: a malformed redirect (3xx without a Location) is not provably
    // cross-host, so we keep the tenant rather than dropping it.
    const fetchFn = mock(async () => new Response(null, { status: 302 }));
    const t = await probeOne("jazzhr", "some-tenant", clientWith(fetchFn), OBSERVED_AT);
    expect(t.status).toBe("live");
  });

  it("treats a 3xx with an unparseable Location as live (defensive)", async () => {
    // A Location that fails URL parsing isn't provably cross-host either, so
    // the tenant is kept rather than dropped on a malformed redirect.
    const fetchFn = mock(
      async () => new Response(null, { status: 302, headers: { location: "http://" } }),
    );
    const t = await probeOne("jazzhr", "some-tenant", clientWith(fetchFn), OBSERVED_AT);
    expect(t.status).toBe("live");
  });

  it("classifies a hiringthing cross-host 302 (vendor marketing bounce) as dead", async () => {
    // An unknown `*.hiringthing.com` subdomain answers /api/rss.xml with a
    // 302 to `www.hiringthing.com` — the cross-host bounce itself is the
    // dead signal (following it would land on the vendor marketing site).
    const fetchFn = mock(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "http://www.hiringthing.com" },
        }),
    );
    const t = await probeOne("hiringthing", "no-such-board", clientWith(fetchFn), OBSERVED_AT);
    expect(t.status).toBe("dead");
  });

  it("probes hiringthing with redirect:manual and classifies a direct 200 feed as live", async () => {
    let seenRedirect: string | undefined;
    const fetchFn = mock(async (_input: Request | string, init?: RequestInit) => {
      seenRedirect = init?.redirect;
      return new Response("<rss version='2.0'><channel/></rss>", { status: 200 });
    });
    const t = await probeOne("hiringthing", "pinnacle", clientWith(fetchFn), OBSERVED_AT);
    expect(t.status).toBe("live");
    expect(seenRedirect).toBe("manual");
  });

  it("classifies an hrmdirect 404 as dead", async () => {
    const fetchFn = mock(async () => new Response("not found", { status: 404 }));
    const t = await probeOne("hrmdirect", "no-such-tenant", clientWith(fetchFn), OBSERVED_AT);
    expect(t.status).toBe("dead");
  });

  it("classifies 404 / 410 as dead", async () => {
    const dead404 = mock(async () => new Response("nope", { status: 404 }));
    const t1 = await probeOne("greenhouse", "stripe", clientWith(dead404), OBSERVED_AT);
    expect(t1.status).toBe("dead");

    const dead410 = mock(async () => new Response("gone", { status: 410 }));
    const t2 = await probeOne("greenhouse", "stripe", clientWith(dead410), OBSERVED_AT);
    expect(t2.status).toBe("dead");
  });

  it("classifies 401 / 403 (auth) as dead", async () => {
    const fetchFn = mock(async () => new Response("nope", { status: 403 }));
    const t = await probeOne("greenhouse", "stripe", clientWith(fetchFn), OBSERVED_AT);
    expect(t.status).toBe("dead");
  });

  it("classifies 5xx and 429 as transient_failure", async () => {
    const fetchFn = mock(async () => new Response("bad", { status: 503 }));
    const t = await probeOne("greenhouse", "stripe", clientWith(fetchFn), OBSERVED_AT);
    expect(t.status).toBe("transient_failure");
  });

  it("classifies network errors as transient_failure", async () => {
    const fetchFn = mock(async () => {
      throw new Error("network down");
    });
    const t = await probeOne("greenhouse", "stripe", clientWith(fetchFn), OBSERVED_AT);
    expect(t.status).toBe("transient_failure");
  });

  it("rejects invalid slugs without making a request", async () => {
    const fetchFn = mock(async () => new Response("ok", { status: 200 }));
    const t = await probeOne("greenhouse", "evil.com", clientWith(fetchFn), OBSERVED_AT);
    expect(t.status).toBe("dead");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("returns transient_failure for workday without metadata.host", async () => {
    // Without `host` we can't compose a probe URL at all; the
    // `site` defaults to "External" but a probe URL still needs a host.
    const fetchFn = mock(async () => new Response("ok", { status: 200 }));
    const t = await probeOne("workday", "stripe", clientWith(fetchFn), OBSERVED_AT);
    expect(t.status).toBe("transient_failure");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("probes workday live via the user-facing /<site> URL", async () => {
    const fetchFn = mock(async (input: Request | string) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.endsWith("/External") && urlHostIs(url, "example.wd5.myworkdayjobs.com")) {
        return new Response("ok", { status: 200 });
      }
      return new Response("nope", { status: 404 });
    });
    const t = await probeOne("workday", "example", clientWith(fetchFn), OBSERVED_AT, {
      host: "example.wd5.myworkdayjobs.com",
      site: "External",
    });
    expect(t.status).toBe("live");
    expect(t.metadata).toEqual({
      host: "example.wd5.myworkdayjobs.com",
      site: "External",
    });
  });

  it("maps homerun 403 to transient_failure (anti-bot ELB), not dead", async () => {
    // Without this carve-out, AWS ELB's blanket 403 against every
    // *.homerun.co probe would mark all 1,780 homerun tenants `dead`
    // and lose the corpus from queryable surface. See cb42f6b history.
    const fetchFn = mock(async () => new Response("blocked", { status: 403 }));
    const t = await probeOne("homerun", "veriff", clientWith(fetchFn), OBSERVED_AT);
    expect(t.status).toBe("transient_failure");
  });

  it("probes workday with default site=External when metadata.site is missing", async () => {
    // Recovers the 4,251 of 4,295 workday tenants whose CDX rows
    // captured `host` but not `site` — the bootstrap-merged site is
    // unknown for those, so we fall back to the most common public
    // workday site name.
    const fetchFn = mock(async (input: Request | string) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.endsWith("/External")) return new Response("ok", { status: 200 });
      return new Response("nope", { status: 404 });
    });
    const t = await probeOne("workday", "example", clientWith(fetchFn), OBSERVED_AT, {
      host: "example.wd5.myworkdayjobs.com",
    });
    expect(t.status).toBe("live");
  });

  it("returns transient_failure for workday when metadata.host fails the safe-host check", async () => {
    const fetchFn = mock(async () => new Response("ok", { status: 200 }));
    // Host doesn't match `*.wd\d+(?:-suffix)?\.myworkdayjobs\.com` — assertWorkdayHost rejects.
    const t = await probeOne("workday", "example", clientWith(fetchFn), OBSERVED_AT, {
      host: "evil.example.com",
      site: "External",
    });
    expect(t.status).toBe("transient_failure");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("returns transient_failure for ultipro without metadata", async () => {
    const fetchFn = mock(async () => new Response("ok", { status: 200 }));
    const t = await probeOne("ultipro", "abc1002awcn", clientWith(fetchFn), OBSERVED_AT);
    expect(t.status).toBe("transient_failure");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("probes ultipro live via POST with JSON body and uppercases the slug in the URL", async () => {
    let probedUrl = "";
    let probedMethod = "";
    let probedBody: string | null = null;
    const fetchFn = mock(async (input: Request | string, init?: RequestInit) => {
      probedUrl = typeof input === "string" ? input : input.url;
      probedMethod = init?.method ?? "GET";
      probedBody = typeof init?.body === "string" ? init.body : null;
      return new Response('{"opportunities":[],"totalCount":0}', { status: 200 });
    });
    const guid = "12345678-1234-1234-1234-123456789012";
    const t = await probeOne("ultipro", "abc1002awcn", clientWith(fetchFn), OBSERVED_AT, {
      board_id: guid,
    });
    expect(t.status).toBe("live");
    expect(probedMethod).toBe("POST");
    expect(probedBody).toBe("{}");
    expect(probedUrl).toContain("ABC1002AWCN");
    expect(probedUrl).toContain(`JobBoard/${guid}`);
  });

  it("rejects malformed ultipro board_id at probe-build time", async () => {
    const fetchFn = mock(async () => new Response("ok", { status: 200 }));
    const t = await probeOne("ultipro", "abc1002awcn", clientWith(fetchFn), OBSERVED_AT, {
      board_id: "not-a-guid",
    });
    expect(t.status).toBe("transient_failure");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("classifies workday metadata-probed 5xx as transient_failure", async () => {
    const fetchFn = mock(async () => new Response("oops", { status: 503 }));
    const t = await probeOne("workday", "example", clientWith(fetchFn), OBSERVED_AT, {
      host: "example.wd5.myworkdayjobs.com",
      site: "External",
    });
    expect(t.status).toBe("transient_failure");
  });

  it("classifies workday metadata-probed 404 as dead", async () => {
    const fetchFn = mock(async () => new Response("nope", { status: 404 }));
    const t = await probeOne("workday", "example", clientWith(fetchFn), OBSERVED_AT, {
      host: "example.wd5.myworkdayjobs.com",
      site: "External",
    });
    expect(t.status).toBe("dead");
  });

  it("auto-discovers workday metadata.site from robots.txt on first live probe", async () => {
    // Google-style tenants use a custom site label (`GOCJobs`); without
    // discovery the cxs JSON 404s for ~70% of harvested workday tenants.
    // Probe pulls the label out of the host's /robots.txt Allow directive
    // and writes it back into metadata so the scraper can reuse it.
    const fetchFn = mock(async (input: Request | string) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.endsWith("/robots.txt")) {
        return new Response("User-agent: *\nAllow: /GOCJobs/\n", { status: 200 });
      }
      return new Response("ok", { status: 200 });
    });
    const t = await probeOne("workday", "google", clientWith(fetchFn), OBSERVED_AT, {
      host: "google.wd5.myworkdayjobs.com",
    });
    expect(t.status).toBe("live");
    expect(t.metadata?.["site"]).toBe("GOCJobs");
  });

  it("does not re-discover workday metadata.site when already set", async () => {
    let robotsCalls = 0;
    const fetchFn = mock(async (input: Request | string) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.endsWith("/robots.txt")) {
        robotsCalls += 1;
        return new Response("User-agent: *\nAllow: /Renamed/\n", { status: 200 });
      }
      return new Response("ok", { status: 200 });
    });
    const t = await probeOne("workday", "example", clientWith(fetchFn), OBSERVED_AT, {
      host: "example.wd5.myworkdayjobs.com",
      site: "External",
    });
    expect(t.status).toBe("live");
    // Site preserved as-is; no robots.txt fetch was issued.
    expect(t.metadata?.["site"]).toBe("External");
    expect(robotsCalls).toBe(0);
  });

  it("re-discovers workday metadata.site when forceRediscover is set", async () => {
    let robotsCalls = 0;
    const fetchFn = mock(async (input: Request | string) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.endsWith("/robots.txt")) {
        robotsCalls += 1;
        return new Response("User-agent: *\nAllow: /Renamed/\n", { status: 200 });
      }
      return new Response("ok", { status: 200 });
    });
    const tenants = await probeMany("workday", ["example"], {
      client: clientWith(fetchFn),
      observedAt: OBSERVED_AT,
      metadataBySlug: new Map([
        ["example", { host: "example.wd5.myworkdayjobs.com", site: "External" }],
      ]),
      forceRediscover: true,
    });
    expect(tenants[0]?.status).toBe("live");
    expect(tenants[0]?.metadata?.["site"]).toBe("Renamed");
    expect(robotsCalls).toBe(1);
  });

  it("leaves workday metadata.site unset when robots.txt has no extractable label", async () => {
    // ~30% of workday tenants ship an empty robots.txt or one with only
    // Disallow lines. Discovery returns null and the scraper falls back
    // to the hardcoded External / Careers chain.
    const fetchFn = mock(async (input: Request | string) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.endsWith("/robots.txt")) {
        return new Response("User-agent: *\nDisallow: /\n", { status: 200 });
      }
      return new Response("ok", { status: 200 });
    });
    const t = await probeOne("workday", "example", clientWith(fetchFn), OBSERVED_AT, {
      host: "example.wd5.myworkdayjobs.com",
    });
    expect(t.status).toBe("live");
    expect(t.metadata?.["site"]).toBeUndefined();
    expect(t.metadata?.["host"]).toBe("example.wd5.myworkdayjobs.com");
  });

  it("probes successfactors live via /career?company={slug} on the discovered host", async () => {
    // SF tenants are addressed by company= query param on a regional
    // datacenter host. Harvest captures `host` from CDX; the probe
    // verifies the company identifier is recognised by SF.
    let probedUrl = "";
    const fetchFn = mock(async (input: Request | string) => {
      probedUrl = typeof input === "string" ? input : input.url;
      return new Response("<html>ok</html>", { status: 200 });
    });
    const t = await probeOne("successfactors", "acme", clientWith(fetchFn), OBSERVED_AT, {
      host: "career4.successfactors.eu",
    });
    expect(t.status).toBe("live");
    expect(probedUrl).toBe("https://career4.successfactors.eu/career?company=acme");
  });

  it("returns transient_failure for successfactors without metadata.host", async () => {
    // Mirrors the workday/ultipro convention: composite metadata is
    // mandatory, not slug-derivable. The tenant stays at
    // transient_failure until harvest surfaces a regional datacenter.
    const fetchFn = mock(async () => new Response("<html>ok</html>", { status: 200 }));
    const t = await probeOne("successfactors", "acme", clientWith(fetchFn), OBSERVED_AT);
    expect(t.status).toBe("transient_failure");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("returns transient_failure for successfactors when metadata is supplied but lacks host", async () => {
    const fetchFn = mock(async () => new Response("ok", { status: 200 }));
    const t = await probeOne("successfactors", "acme", clientWith(fetchFn), OBSERVED_AT, {
      seeded: "1",
    });
    expect(t.status).toBe("transient_failure");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("rejects an SSRF-shaped successfactors host before dispatching", async () => {
    const fetchFn = mock(async () => new Response("ok", { status: 200 }));
    const t = await probeOne("successfactors", "acme", clientWith(fetchFn), OBSERVED_AT, {
      host: "evil.example.com",
    });
    expect(t.status).toBe("transient_failure");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("probes brassring live by GETting the home URL on sjobs.brassring.com", async () => {
    let probedUrl = "";
    const fetchFn = mock(async (input: Request | string) => {
      probedUrl = typeof input === "string" ? input : input.url;
      return new Response("<html>ok</html>", { status: 200 });
    });
    const t = await probeOne("brassring", "publix", clientWith(fetchFn), OBSERVED_AT, {
      partnerid: "26173",
      siteid: "5197",
    });
    expect(t.status).toBe("live");
    expect(probedUrl).toBe(
      "https://sjobs.brassring.com/TGNewUI/Search/Home/Home?partnerid=26173&siteid=5197",
    );
  });

  it("returns transient_failure for brassring missing metadata.partnerid", async () => {
    const fetchFn = mock(async () => new Response("ok", { status: 200 }));
    const t = await probeOne("brassring", "publix", clientWith(fetchFn), OBSERVED_AT, {
      siteid: "5197",
    });
    expect(t.status).toBe("transient_failure");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("rejects non-numeric brassring ids before any HTTP fires", async () => {
    const fetchFn = mock(async () => new Response("ok", { status: 200 }));
    const t = await probeOne("brassring", "publix", clientWith(fetchFn), OBSERVED_AT, {
      partnerid: "26173 OR 1=1",
      siteid: "5197",
    });
    expect(t.status).toBe("transient_failure");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("probes jsonld live by GETting the supplied sitemap_url", async () => {
    let probedUrl = "";
    const fetchFn = mock(async (input: Request | string) => {
      probedUrl = typeof input === "string" ? input : input.url;
      return new Response("<urlset></urlset>", {
        status: 200,
        headers: { "content-type": "application/xml" },
      });
    });
    const t = await probeOne("jsonld", "example", clientWith(fetchFn), OBSERVED_AT, {
      sitemap_url: "https://careers.example.com/sitemap.xml",
    });
    expect(t.status).toBe("live");
    expect(probedUrl).toBe("https://careers.example.com/sitemap.xml");
  });

  it("returns transient_failure for jsonld without metadata.sitemap_url", async () => {
    const fetchFn = mock(async () => new Response("ok", { status: 200 }));
    const t = await probeOne("jsonld", "example", clientWith(fetchFn), OBSERVED_AT);
    expect(t.status).toBe("transient_failure");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("rejects malformed jsonld sitemap_url before dispatching", async () => {
    const fetchFn = mock(async () => new Response("ok", { status: 200 }));
    const t = await probeOne("jsonld", "example", clientWith(fetchFn), OBSERVED_AT, {
      sitemap_url: "not a url",
    });
    expect(t.status).toBe("transient_failure");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("rejects http jsonld sitemap_url (no TLS)", async () => {
    const fetchFn = mock(async () => new Response("ok", { status: 200 }));
    const t = await probeOne("jsonld", "example", clientWith(fetchFn), OBSERVED_AT, {
      sitemap_url: "http://careers.example.com/sitemap.xml",
    });
    expect(t.status).toBe("transient_failure");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("rejects loopback and private-suffix jsonld sitemap hosts (SSRF guard)", async () => {
    const fetchFn = mock(async () => new Response("ok", { status: 200 }));
    for (const host of ["localhost", "internal.local", "metadata.internal"]) {
      const t = await probeOne("jsonld", "example", clientWith(fetchFn), OBSERVED_AT, {
        sitemap_url: `https://${host}/sitemap.xml`,
      });
      expect(t.status).toBe("transient_failure");
    }
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("probes gjobsfeed live by GETting the supplied feed_url", async () => {
    let probedUrl = "";
    const fetchFn = mock(async (input: Request | string) => {
      probedUrl = typeof input === "string" ? input : input.url;
      return new Response("<rss version='2.0'><channel></channel></rss>", {
        status: 200,
        headers: { "content-type": "application/xml" },
      });
    });
    const t = await probeOne("gjobsfeed", "sap", clientWith(fetchFn), OBSERVED_AT, {
      feed_url: "https://jobs.sap.com/sitemap.xml",
    });
    expect(t.status).toBe("live");
    expect(probedUrl).toBe("https://jobs.sap.com/sitemap.xml");
  });

  it("returns transient_failure for gjobsfeed without metadata.feed_url", async () => {
    const fetchFn = mock(async () => new Response("ok", { status: 200 }));
    const t = await probeOne("gjobsfeed", "sap", clientWith(fetchFn), OBSERVED_AT);
    expect(t.status).toBe("transient_failure");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("rejects malformed / http / SSRF gjobsfeed feed_url before dispatching", async () => {
    const fetchFn = mock(async () => new Response("ok", { status: 200 }));
    for (const feed of [
      "not a url",
      "http://jobs.sap.com/sitemap.xml",
      "https://localhost/feed.xml",
      "https://feed.internal/feed.xml",
      "https://169.254.169.254/feed.xml",
    ]) {
      const t = await probeOne("gjobsfeed", "sap", clientWith(fetchFn), OBSERVED_AT, {
        feed_url: feed,
      });
      expect(t.status).toBe("transient_failure");
    }
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("does not block the workday probe when robots.txt fetch fails", async () => {
    // robots.txt may 404 / time out / be CDN-blocked — discovery is
    // best-effort. The liveness verdict must still hold.
    const fetchFn = mock(async (input: Request | string) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.endsWith("/robots.txt")) {
        throw new Error("network down");
      }
      return new Response("ok", { status: 200 });
    });
    const t = await probeOne("workday", "example", clientWith(fetchFn), OBSERVED_AT, {
      host: "example.wd5.myworkdayjobs.com",
    });
    expect(t.status).toBe("live");
    expect(t.metadata?.["site"]).toBeUndefined();
  });
});

describe("probeMany", () => {
  it("probes a list of slugs respecting concurrency", async () => {
    let inFlight = 0;
    let peak = 0;
    const fetchFn = mock(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return new Response("[]", { status: 200 });
    });
    const tenants = await probeMany("greenhouse", ["a", "b", "c", "d", "e", "f", "g"], {
      client: clientWith(fetchFn),
      observedAt: OBSERVED_AT,
      concurrency: 2,
    });
    expect(tenants).toHaveLength(7);
    expect(peak).toBeLessThanOrEqual(2);
    expect(tenants.every((t) => t.status === "live")).toBe(true);
  });

  it("caps shared-host ATS concurrency below the requested value (workable=1)", async () => {
    // PROBE_HOST_CONCURRENCY caps workable at 1 to avoid the CDN
    // rate-limit / IP-ban scenario. Even when the caller asks for 6,
    // the actual peak in-flight must stay at 1 against `apply.workable.com`.
    let inFlight = 0;
    let peak = 0;
    const fetchFn = mock(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return new Response("[]", { status: 200 });
    });
    await probeMany("workable", ["a", "b", "c", "d", "e", "f"], {
      client: clientWith(fetchFn),
      observedAt: OBSERVED_AT,
      concurrency: 6,
    });
    expect(peak).toBe(1);
  });

  it("does not cap per-subdomain ATSes (bamboohr uses caller's concurrency)", async () => {
    // Per-subdomain ATSes hit a different host per probe, so the host
    // cap doesn't apply. With concurrency=4 the peak should reach 4.
    let inFlight = 0;
    let peak = 0;
    const fetchFn = mock(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight -= 1;
      return new Response("ok", { status: 200 });
    });
    await probeMany("bamboohr", ["a", "b", "c", "d", "e", "f"], {
      client: clientWith(fetchFn),
      observedAt: OBSERVED_AT,
      concurrency: 4,
    });
    expect(peak).toBe(4);
  });
});
