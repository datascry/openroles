import { describe, expect, it } from "bun:test";
import { ATS_IDS } from "@openroles/shared";
import { HARVEST_ATS_IDS, harvestPatternFor } from "./patterns.ts";

describe("harvestPatternFor", () => {
  it("returns a pattern for every canonical ATS", () => {
    for (const ats of ATS_IDS) {
      const p = harvestPatternFor(ats);
      expect(p.ats).toBe(ats);
      expect(p.cdxQuery.length).toBeGreaterThan(0);
      expect(p.regex.global).toBe(true);
    }
  });

  it("HARVEST_ATS_IDS exactly matches ATS_IDS as a set", () => {
    expect(new Set(HARVEST_ATS_IDS)).toEqual(new Set(ATS_IDS));
  });

  it("greenhouse pattern extracts the canonical /{slug} board URL", () => {
    const { regex, denyList } = harvestPatternFor("greenhouse");
    const sample =
      "https://boards.greenhouse.io/stripe/jobs/123 " +
      "https://boards.greenhouse.io/anthropic?utm=x";
    const matches = Array.from(sample.matchAll(regex)).map((m) => m[1] as string);
    expect(matches).toContain("stripe");
    expect(matches).toContain("anthropic");
    // /embed/* paths are blocked by greenhouse's robots.txt and never appear
    // in CDX; the pattern intentionally has no `embed` arm. The deny list
    // still excludes `embed` in case a stray URL matches the path-after-host.
    expect(denyList.has("embed")).toBe(true);
  });

  it("workday pattern handles wd5-impl tier subdomains", () => {
    const { regex } = harvestPatternFor("workday");
    const m = Array.from(
      "https://acme.wd5-impl.myworkdayjobs.com/External https://acme.wd1.myworkdayjobs.com".matchAll(
        regex,
      ),
    ).map((x) => x[1]);
    expect(m).toContain("acme");
    expect(m.length).toBeGreaterThanOrEqual(2);
  });

  it("successfactors pattern extracts slug from company= and host from regional cluster", () => {
    const pattern = harvestPatternFor("successfactors");
    const { regex, extractMetadata } = pattern;
    const sample =
      "https://career4.successfactors.eu/career?company=acme&career_ns=job_listing " +
      "https://career2.successfactors.com/career?career_ns=job_listing&company=widgetco";
    const re = new RegExp(regex.source, regex.flags);
    const matches = Array.from(sample.matchAll(re));
    const slugs = matches.map((m) => m[1]);
    expect(slugs).toContain("acme");
    expect(slugs).toContain("widgetco");
    // extractMetadata recovers the regional datacenter host from the
    // full match string (SF is the only ATS where slug !== host suffix,
    // so the metadata extractor is non-positional).
    expect(extractMetadata).toBeDefined();
    const meta1 = extractMetadata?.(matches[0] as RegExpExecArray);
    expect(meta1).toEqual({ host: "career4.successfactors.eu" });
    const meta2 = extractMetadata?.(matches[1] as RegExpExecArray);
    expect(meta2).toEqual({ host: "career2.successfactors.com" });
  });

  it("successfactors extractMetadata returns undefined when match[0] lacks a valid SF host", () => {
    const pattern = harvestPatternFor("successfactors");
    // Synthesize a RegExpExecArray-shaped object whose match[0] is a
    // non-SF host — the host-recovery regex inside extractMetadata
    // must fail closed.
    const fake = Object.assign(["https://evil.example.com/career?company=acme", "acme"], {
      index: 0,
      input: "https://evil.example.com/career?company=acme",
    }) as unknown as RegExpExecArray;
    expect(pattern.extractMetadata?.(fake)).toBeUndefined();
  });

  it("workstream pattern extracts slug (group 1) and company_id via extractMetadata", () => {
    const pattern = harvestPatternFor("workstream");
    const { regex, extractMetadata } = pattern;
    const sample =
      "https://www.workstream.us/j/ab12cd34/acme-grill/positions " +
      "https://www.workstream.us/j/1d35674b/joey-restaurants?locale=en";
    const re = new RegExp(regex.source, regex.flags);
    const matches = Array.from(sample.matchAll(re));
    expect(matches.map((m) => m[1])).toEqual(["acme-grill", "joey-restaurants"]);
    expect(extractMetadata).toBeDefined();
    expect(extractMetadata?.(matches[0] as RegExpExecArray)).toEqual({ company_id: "ab12cd34" });
    expect(extractMetadata?.(matches[1] as RegExpExecArray)).toEqual({ company_id: "1d35674b" });
  });

  it("workstream pattern rejects non-hex company ids and workstream extractMetadata fails closed", () => {
    const { regex, extractMetadata } = harvestPatternFor("workstream");
    // A /j/ path whose first segment is not an 8-hex id never matches.
    const re = new RegExp(regex.source, regex.flags);
    expect(Array.from("https://www.workstream.us/j/notanid/acme/positions".matchAll(re))).toEqual(
      [],
    );
    // Synthesize a match whose full string lacks the /j/{8-hex}/ shape —
    // the id-recovery regex inside extractMetadata must return undefined.
    const fake = Object.assign(["workstream.us/j/acme-grill", "acme-grill"], {
      index: 0,
      input: "workstream.us/j/acme-grill",
    }) as unknown as RegExpExecArray;
    expect(extractMetadata?.(fake)).toBeUndefined();
  });

  it("bamboohr pattern matches subdomain slugs", () => {
    const { regex } = harvestPatternFor("bamboohr");
    const m = Array.from("https://stripe.bamboohr.com/careers/list".matchAll(regex)).map(
      (x) => x[1],
    );
    expect(m).toContain("stripe");
  });

  it("icims pattern captures the full subdomain label as the slug", () => {
    const { regex } = harvestPatternFor("icims");
    // Real-world iCIMS hostname shapes — only ~57% start with `careers-`,
    // the rest use varied branded prefixes or composite labels.
    const sample = [
      "https://careers-example.icims.com/jobs/1234/role/job",
      "https://newprocareers-renovo.icims.com/jobs/1/x",
      "https://1stheritage-attainfinance.icims.com/",
      "https://accesssolutions-skyclimber.icims.com/jobs",
    ].join(" ");
    const m = Array.from(sample.matchAll(regex)).map((x) => x[1]);
    expect(m).toEqual(
      expect.arrayContaining([
        "careers-example",
        "newprocareers-renovo",
        "1stheritage-attainfinance",
        "accesssolutions-skyclimber",
      ]),
    );
  });

  it("isolvedhire pattern matches subdomain slugs and denies the platform feeds host", () => {
    const { regex, denyList } = harvestPatternFor("isolvedhire");
    const m = Array.from(
      "https://safetireauto.isolvedhire.com/jobs/ https://feeds.isolvedhire.com/site_map_index.xml".matchAll(
        regex,
      ),
    ).map((x) => x[1]);
    expect(m).toContain("safetireauto");
    // `feeds` is the platform-wide sitemap host, not a tenant.
    expect(denyList.has("feeds")).toBe(true);
    expect(denyList.has("www")).toBe(true);
  });

  it("applicantpool pattern matches subdomain slugs and denies the platform feeds host", () => {
    const { regex, denyList } = harvestPatternFor("applicantpool");
    const m = Array.from(
      "https://scientificdrilling.applicantpool.com/jobs/ https://feeds.applicantpool.com/site_map_index.xml".matchAll(
        regex,
      ),
    ).map((x) => x[1]);
    expect(m).toContain("scientificdrilling");
    // `feeds` is the platform-wide sitemap host, not a tenant.
    expect(denyList.has("feeds")).toBe(true);
    expect(denyList.has("www")).toBe(true);
  });

  it("icims cdxQuery uses the * domain prefix that CDX actually honors", () => {
    // CDX prefix-match semantics on URL queries are rooted at the registrable
    // domain in SURT form; wildcards inside a host segment do not work. The
    // legacy `careers-*.icims.com/*` query returned 0 records empirically.
    expect(harvestPatternFor("icims").cdxQuery).toBe("*.icims.com/*");
  });

  it("regex enforces RFC 1123 (no leading or trailing hyphen) for slugs", () => {
    const { regex } = harvestPatternFor("greenhouse");
    const noLeading = Array.from("https://boards.greenhouse.io/-bad/jobs".matchAll(regex)).map(
      (x) => x[1],
    );
    const noTrailing = Array.from("https://boards.greenhouse.io/bad-/jobs".matchAll(regex)).map(
      (x) => x[1],
    );
    expect(noLeading).not.toContain("-bad");
    expect(noTrailing).not.toContain("bad-");
  });

  it("phase-6 custom ATS patterns emit the canonical single-tenant slug", () => {
    const cases: Array<[string, string, string]> = [
      ["amazonjobs", "https://amazon.jobs/en/jobs/1234567", "amazon"],
      ["applejobs", "https://jobs.apple.com/en-us/details/200512345", "apple"],
      ["tiktokcareers", "https://careers.tiktok.com/position/7283456789/detail", "tiktok"],
      ["metacareers", "https://www.metacareers.com/jobs/1234567890/", "meta"],
      // Meta also accepts the bare host:
      ["metacareers", "https://metacareers.com/jobs", "meta"],
      // SchoolSpring: www-prefixed and bare host both emit the slug.
      ["schoolspring", "https://www.schoolspring.com/jobdetail?jobId=5815345", "schoolspring"],
      ["schoolspring", "https://schoolspring.com/", "schoolspring"],
    ];
    for (const [ats, url, expectedSlug] of cases) {
      const { regex } = harvestPatternFor(ats as Parameters<typeof harvestPatternFor>[0]);
      const re = new RegExp(regex.source, regex.flags);
      const m = re.exec(url);
      expect(m).not.toBeNull();
      expect(m?.[1]).toBe(expectedSlug);
    }
  });

  it("applitrack pattern captures the district path segment on the shared host", () => {
    const { regex, denyList } = harvestPatternFor("applitrack");
    const sample =
      "https://www.applitrack.com/carolinecounty/onlineapp/jobpostings/view.asp?AppliTrackJobId=123 " +
      "https://www.applitrack.com/tesd/onlineapp/default.aspx " +
      "https://www.applitrack.com/olacommon/jobpostings/css/output.css";
    const matches = Array.from(sample.matchAll(regex)).map((m) => m[1] as string);
    expect(matches).toContain("carolinecounty");
    expect(matches).toContain("tesd");
    // Shared asset / app paths on the host must never mint tenants.
    expect(denyList.has("olacommon")).toBe(true);
    expect(denyList.has("onlineapp")).toBe(true);
    expect(denyList.has("admin")).toBe(true);
  });

  it("manatal pattern captures the first path segment and excludes /job/ deep links from minting a phantom slug", () => {
    const { regex, denyList } = harvestPatternFor("manatal");
    const sample =
      "https://www.careers-page.com/manatal " +
      "https://www.careers-page.com/blr-world/job/5WR47RRR " +
      "https://www.careers-page.com/gaprecruitment/ " +
      "https://evil.example.com/hacker/job/9999";
    const matches = Array.from(sample.matchAll(regex)).map((m) => m[1] as string);
    // A job deep link mints its tenant slug (the first segment), never `job`.
    expect(matches).toEqual(["manatal", "blr-world", "gaprecruitment"]);
    expect(matches).not.toContain("job");
    // Off-host links can never mint a tenant.
    expect(matches).not.toContain("hacker");
    // Belt-and-braces: `job` is denied so a pathological capture can't leak.
    expect(denyList.has("job")).toBe(true);
    expect(denyList.has("admin")).toBe(true);
  });

  it("hirebridge pattern captures the numeric cid query parameter", () => {
    // Hirebridge is a shared-host ATS: the tenant identity is the `cid`
    // query parameter, not a DNS label, so the capture reads the query
    // string on both the listing and the JobDetails deep link — including
    // entity-encoded HTML sources (`&amp;cid=`).
    const { regex, denyList } = harvestPatternFor("hirebridge");
    const sample =
      "https://recruit.hirebridge.com/v3/jobs/list.aspx?cid=5535 " +
      "https://recruit.hirebridge.com/v3/Jobs/JobDetails.aspx?cid=8419&jid=651294 " +
      "https://recruit.hirebridge.com/v3/CareerCenter/v2/details.aspx?jid=730878&amp;cid=7997 " +
      "https://evil.example.com/v3/jobs/list.aspx?cid=1111";
    const re = new RegExp(regex.source, regex.flags);
    const matches = Array.from(sample.matchAll(re)).map((m) => m[1]);
    expect(matches).toEqual(["5535", "8419", "7997"]); // off-host cid ignored
    expect(denyList.size).toBe(0); // numeric capture — no reserved words to deny
  });

  it("taleotbe pattern extracts the org slug and host/instance/cws metadata", () => {
    const { regex, extractMetadata } = harvestPatternFor("taleotbe");
    const sample =
      "https://phh.tbe.taleo.net/phh03/ats/careers/searchResults.jsp?org=INVXIS&cws=37 " +
      "https://tre.tbe.taleo.net/tre01/ats/careers/requisition.jsp?org=CITYBURNABY&cws=1&rid=633";
    const re = new RegExp(regex.source, regex.flags);
    const matches = Array.from(sample.matchAll(re));
    // extractSlugs lowercases group 1; mirror that here.
    expect(matches.map((m) => m[1]?.toLowerCase())).toEqual(["invxis", "cityburnaby"]);
    expect(extractMetadata?.(matches[0] as RegExpExecArray)).toEqual({
      host: "phh.tbe.taleo.net",
      instance: "phh03",
      cws: "37",
    });
    expect(extractMetadata?.(matches[1] as RegExpExecArray)).toEqual({
      host: "tre.tbe.taleo.net",
      instance: "tre01",
      cws: "1",
    });
  });

  it("taleotbe pattern omits cws when the URL lacks it and fails closed on a bad host", () => {
    const { regex, extractMetadata } = harvestPatternFor("taleotbe");
    const re = new RegExp(regex.source, regex.flags);
    const m = re.exec("https://lde.tbe.taleo.net/lde01/ats/careers/viewRequisition?org=URSAUS");
    expect(m?.[1]?.toLowerCase()).toBe("ursaus");
    expect(extractMetadata?.(m as RegExpExecArray)).toEqual({
      host: "lde.tbe.taleo.net",
      instance: "lde01",
    });
    // A synthesized match whose match[0] lacks the pod-host shape must
    // fail closed rather than emit junk metadata.
    const fake = Object.assign(["https://evil.example.com/ats/careers/x?org=ACME", "ACME"], {
      index: 0,
      input: "https://evil.example.com/ats/careers/x?org=ACME",
    }) as unknown as RegExpExecArray;
    expect(extractMetadata?.(fake)).toBeUndefined();
  });

  it("taleotbe pattern does not match the enterprise taleo pool", () => {
    const { regex } = harvestPatternFor("taleotbe");
    const re = new RegExp(regex.source, regex.flags);
    expect(re.exec("https://acme.taleo.net/careersection/jobsearch.ftl?org=ACME")).toBeNull();
  });

  it("pageup pattern extracts the clientkey slug and host/instance/clientkey metadata", () => {
    const { regex, extractMetadata } = harvestPatternFor("pageup");
    const sample =
      "https://careers.pageuppeople.com/438/caw/en/listing/ " +
      "https://careersmanager.pageuppeople.com/541/ce/en/job/721048/head-chef";
    const re = new RegExp(regex.source, regex.flags);
    const matches = Array.from(sample.matchAll(re));
    // extractSlugs lowercases group 1 (the clientkey); mirror that here.
    expect(matches.map((m) => m[1]?.toLowerCase())).toEqual(["caw", "ce"]);
    expect(extractMetadata?.(matches[0] as RegExpExecArray)).toEqual({
      host: "careers.pageuppeople.com",
      instance: "438",
      clientkey: "caw",
    });
    expect(extractMetadata?.(matches[1] as RegExpExecArray)).toEqual({
      host: "careersmanager.pageuppeople.com",
      instance: "541",
      clientkey: "ce",
    });
  });

  it("pageup pattern denies the robots-disallowed demo/UAT clientkeys and fails closed", () => {
    const { regex, denyList, extractMetadata } = harvestPatternFor("pageup");
    // The `ci`/`uat`/`staging` demo keys PageUp's robots.txt disallows are in
    // the deny list, so extractSlugs never mints a phantom tenant for them.
    for (const key of ["ci", "uat", "staging"]) expect(denyList.has(key)).toBe(true);
    // A synthesized match whose match[0] lacks the pod path must fail closed.
    const fake = Object.assign(["https://evil.example.com/1/x/en/listing", "x"], {
      index: 0,
      input: "https://evil.example.com/1/x/en/listing",
    }) as unknown as RegExpExecArray;
    expect(extractMetadata?.(fake)).toBeUndefined();
    // A non-PageUp host does not match at all.
    const re = new RegExp(regex.source, regex.flags);
    expect(re.exec("https://careers.example.com/438/caw/en/listing/")).toBeNull();
  });

  it("hireology pattern extracts the first path segment on the shared SPA host", () => {
    const { regex, denyList } = harvestPatternFor("hireology");
    const sample =
      "https://careers.hireology.com/homeinsteadoftheblackhills/2784438/description " +
      "https://careers.hireology.com/homeinstead-evansvillein?utm=x " +
      "https://careers.hireology.com/api/health";
    const re = new RegExp(regex.source, regex.flags);
    const matches = Array.from(sample.matchAll(re)).map((m) => m[1] as string);
    expect(matches).toContain("homeinsteadoftheblackhills");
    expect(matches).toContain("homeinstead-evansvillein");
    // Reserved path words on the shared host are not tenants.
    expect(denyList.has("api")).toBe(true);
  });

  it("jobscore pattern extracts the slug after /jobs/ on the shared host", () => {
    const { regex, denyList } = harvestPatternFor("jobscore");
    const sample =
      "https://careers.jobscore.com/jobs/gooddayfarm/feed.json " +
      "https://careers.jobscore.com/jobs/pacificprogrammanagement?utm=x " +
      "https://careers.jobscore.com/jobs/solutions2go/ " +
      "https://careers.jobscore.com/jobs/api/health";
    const re = new RegExp(regex.source, regex.flags);
    const matches = Array.from(sample.matchAll(re)).map((m) => m[1] as string);
    expect(matches).toContain("gooddayfarm");
    expect(matches).toContain("pacificprogrammanagement");
    expect(matches).toContain("solutions2go");
    // Reserved path words on the shared host are not tenants.
    expect(denyList.has("api")).toBe(true);
  });

  it("rippling pattern extracts the first path segment on the shared board host", () => {
    const { regex, denyList } = harvestPatternFor("rippling");
    const sample =
      "https://ats.rippling.com/routeware-careers/jobs/4345711d-74af-400f-8872-8b1b5393dcdf " +
      "https://ats.rippling.com/fifth-season-careers/jobs?utm=x " +
      "https://ats.rippling.com/internal/health";
    const re = new RegExp(regex.source, regex.flags);
    const matches = Array.from(sample.matchAll(re)).map((m) => m[1] as string);
    expect(matches).toContain("routeware-careers");
    expect(matches).toContain("fifth-season-careers");
    // The one path Rippling's robots.txt disallows is not a tenant.
    expect(denyList.has("internal")).toBe(true);
  });

  it("paycom pattern captures the 32-hex clientkey from both URL surfaces (lowercased)", () => {
    const { regex, denyList } = harvestPatternFor("paycom");
    const sample =
      "https://www.paycomonline.net/v4/ats/web.php/jobs?clientkey=B2BD1063BF1B0A2978EA308E72CCF7D3 " +
      "https://www.paycomonline.net/v4/ats/web.php/portal/091EC3604A527BCAA57D140E2BFAE4A1/career-page " +
      "https://evil.example.com/?clientkey=00000000000000000000000000000000";
    const re = new RegExp(regex.source, regex.flags);
    // extractSlugs lowercases group 1; mirror that here.
    const matches = Array.from(sample.matchAll(re)).map((m) => (m[1] as string).toLowerCase());
    expect(matches).toContain("b2bd1063bf1b0a2978ea308e72ccf7d3");
    expect(matches).toContain("091ec3604a527bcaa57d140e2bfae4a1");
    // The off-host URL is not on paycomonline.net, so it never matches.
    expect(matches).not.toContain("00000000000000000000000000000000");
    // A numeric-hex capture can never collide with a reserved word.
    expect(denyList.size).toBe(0);
  });

  it("throws for unknown ats id", () => {
    expect(() => harvestPatternFor("not-a-real-ats" as any)).toThrow();
  });
});
