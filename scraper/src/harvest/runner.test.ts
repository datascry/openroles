import { afterEach, describe, expect, it, mock } from "bun:test";
import { HttpClient } from "../http.ts";
import { RobotsTxtCache } from "../robots.ts";
import { runHarvest } from "./runner.ts";

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

const FAKE_CDX = [
  '{"url":"https://boards.greenhouse.io/stripe","status":"200","timestamp":"20260101000000"}',
  '{"url":"https://boards.greenhouse.io/anthropic","status":"200","timestamp":"20260101000000"}',
  '{"url":"https://boards.greenhouse.io/anthropic/jobs/123","status":"200","timestamp":"20260101000000"}',
  "",
].join("\n");

describe("runHarvest", () => {
  it("dedupes slugs across snapshots and probes each unique tenant", async () => {
    const fetchFn = mock(async (input: Request | string) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.includes("commoncrawl.org") && url.includes("showNumPages")) {
        return new Response("1", { status: 200 });
      }
      if (url.includes("commoncrawl.org")) {
        return new Response(FAKE_CDX, { status: 200 });
      }
      return new Response("[]", { status: 200 });
    });
    const client = clientWith(fetchFn);
    const result = await runHarvest({
      ats: "greenhouse",
      snapshots: ["2026-13", "2025-50"],
      client,
      observedAt: OBSERVED_AT,
      probeConcurrency: 4,
    });
    expect(result.ats).toBe("greenhouse");
    expect(result.unique_slugs).toBe(2);
    expect(result.tenants.map((t) => t.slug).sort()).toEqual(["anthropic", "stripe"]);
    expect(result.tenants.every((t) => t.status === "live")).toBe(true);
    expect(result.cdx_records).toBeGreaterThan(0);
    expect(result.cdx_pages_fetched).toBe(2);
    expect(result.cdx_fetch_errors).toBe(0);
  });

  it("propagates harvested metadata onto workday tenants and probes them with the composite URL", async () => {
    const cdx = [
      '{"url":"https://example.wd5.myworkdayjobs.com/wday/cxs/example/External/jobs","status":"200","timestamp":"20260101000000"}',
      "",
    ].join("\n");
    let probedHost = "";
    const fetchFn = mock(async (input: Request | string) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.includes("commoncrawl.org") && url.includes("showNumPages")) {
        return new Response("1", { status: 200 });
      }
      if (url.includes("commoncrawl.org")) {
        return new Response(cdx, { status: 200 });
      }
      // Probe URL — capture and 200.
      probedHost = url;
      return new Response("{}", { status: 200 });
    });
    const result = await runHarvest({
      ats: "workday",
      snapshots: ["2026-13"],
      client: clientWith(fetchFn),
      observedAt: OBSERVED_AT,
    });
    expect(result.unique_slugs).toBe(1);
    expect(result.tenants[0]?.slug).toBe("example");
    expect(result.tenants[0]?.status).toBe("live");
    expect(result.tenants[0]?.metadata).toEqual({
      host: "example.wd5.myworkdayjobs.com",
      site: "External",
    });
    expect(probedHost).toContain("example.wd5.myworkdayjobs.com/wday/cxs/example/External/jobs");
  });

  it("keeps workday tenants at transient_failure when CDX yields the host but no site code", async () => {
    const cdx = [
      '{"url":"https://example.wd5.myworkdayjobs.com/job/12345","status":"200","timestamp":"20260101000000"}',
      "",
    ].join("\n");
    const fetchFn = mock(async (input: Request | string) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.includes("commoncrawl.org") && url.includes("showNumPages")) {
        return new Response("1", { status: 200 });
      }
      return new Response(cdx, { status: 200 });
    });
    const result = await runHarvest({
      ats: "workday",
      snapshots: ["2026-13"],
      client: clientWith(fetchFn),
      observedAt: OBSERVED_AT,
    });
    expect(result.tenants[0]?.status).toBe("transient_failure");
    // host alone is preserved on the tenant — useful for follow-up reharvest
    // even though it isn't enough to probe.
    expect(result.tenants[0]?.metadata).toEqual({ host: "example.wd5.myworkdayjobs.com" });
  });

  it("returns slugs as transient_failure when skipProbe is set", async () => {
    const fetchFn = mock(async (input: Request | string) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.includes("showNumPages")) return new Response("1", { status: 200 });
      return new Response(FAKE_CDX, { status: 200 });
    });
    const result = await runHarvest({
      ats: "greenhouse",
      snapshots: ["2026-13"],
      client: clientWith(fetchFn),
      observedAt: OBSERVED_AT,
      skipProbe: true,
    });
    expect(result.tenants.every((t) => t.status === "transient_failure")).toBe(true);
  });

  it("counts cdx_fetch_errors when a CDX request fails (not 404)", async () => {
    const fetchFn = mock(async (input: Request | string) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.includes("showNumPages")) return new Response("1", { status: 200 });
      return new Response("oops", { status: 503 });
    });
    const result = await runHarvest({
      ats: "greenhouse",
      snapshots: ["2026-13"],
      client: clientWith(fetchFn),
      observedAt: OBSERVED_AT,
      skipProbe: true,
    });
    expect(result.cdx_fetch_errors).toBe(1);
    expect(result.unique_slugs).toBe(0);
  });

  it("treats a 404 page response as a no-error empty page", async () => {
    const fetchFn = mock(async (input: Request | string) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.includes("showNumPages")) return new Response("1", { status: 200 });
      return new Response("not found", { status: 404 });
    });
    const result = await runHarvest({
      ats: "greenhouse",
      snapshots: ["2026-13"],
      client: clientWith(fetchFn),
      observedAt: OBSERVED_AT,
      skipProbe: true,
    });
    expect(result.cdx_pages_fetched).toBe(1);
    expect(result.cdx_fetch_errors).toBe(0);
    expect(result.unique_slugs).toBe(0);
  });

  it("paginates when CDX reports more than one page", async () => {
    let pagesSeen = 0;
    const fetchFn = mock(async (input: Request | string) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.includes("showNumPages")) return new Response("3", { status: 200 });
      pagesSeen += 1;
      return new Response(`{"url":"https://boards.greenhouse.io/co-${pagesSeen}","status":"200"}`, {
        status: 200,
      });
    });
    const result = await runHarvest({
      ats: "greenhouse",
      snapshots: ["2026-13"],
      client: clientWith(fetchFn),
      observedAt: OBSERVED_AT,
      skipProbe: true,
    });
    expect(result.cdx_pages_fetched).toBe(3);
    expect(result.unique_slugs).toBe(3);
  });

  it("respects maxSlugsTotal across pages and snapshots", async () => {
    const lots = Array.from(
      { length: 20 },
      (_, i) =>
        `{"url":"https://boards.greenhouse.io/co${i}","status":"200","timestamp":"20260101000000"}`,
    ).join("\n");
    const fetchFn = mock(async (input: Request | string) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.includes("showNumPages")) return new Response("1", { status: 200 });
      return new Response(lots, { status: 200 });
    });
    const result = await runHarvest({
      ats: "greenhouse",
      snapshots: ["2026-13"],
      client: clientWith(fetchFn),
      observedAt: OBSERVED_AT,
      skipProbe: true,
      maxSlugsTotal: 5,
    });
    expect(result.unique_slugs).toBe(5);
  });

  it("respects maxPagesPerSnapshot when CDX reports more pages than the cap", async () => {
    const fetchFn = mock(async (input: Request | string) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.includes("showNumPages")) return new Response("100", { status: 200 });
      return new Response("", { status: 200 });
    });
    const result = await runHarvest({
      ats: "greenhouse",
      snapshots: ["2026-13"],
      client: clientWith(fetchFn),
      observedAt: OBSERVED_AT,
      skipProbe: true,
      maxPagesPerSnapshot: 4,
    });
    expect(result.cdx_pages_fetched).toBe(4);
  });

  it("captures icims tenants whose subdomain prefix is not 'careers-'", async () => {
    // ~43% of real iCIMS tenants use varied prefixes (`newprocareers-`,
    // `accesssolutions-`, composite labels like `1stheritage-attainfinance`).
    // The harvest pattern treats the entire subdomain label as the slug.
    const body = [
      '{"url":"https://careers-callhero.icims.com/jobs/1","status":"200"}',
      '{"url":"https://newprocareers-renovo.icims.com/jobs/2","status":"200"}',
      '{"url":"https://1stheritage-attainfinance.icims.com/","status":"200"}',
    ].join("\n");
    const fetchFn = mock(async (input: Request | string) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.includes("showNumPages")) return new Response("1", { status: 200 });
      return new Response(body, { status: 200 });
    });
    const result = await runHarvest({
      ats: "icims",
      snapshots: ["2026-13"],
      client: clientWith(fetchFn),
      observedAt: OBSERVED_AT,
      skipProbe: true,
    });
    expect(result.tenants.map((t) => t.slug).sort()).toEqual([
      "1stheritage-attainfinance",
      "careers-callhero",
      "newprocareers-renovo",
    ]);
  });
});
