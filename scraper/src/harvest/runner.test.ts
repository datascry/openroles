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
    expect(probedHost).toContain("example.wd5.myworkdayjobs.com/External");
  });

  it("probes workday with default site=External when CDX yields host but no site code", async () => {
    // Bootstrap finding: ~98% of workday tenants come out of CDX with
    // `host` but no `site` (most CDX URLs are bare host pages, not the
    // /wday/cxs/<site>/ API). Probe falls back to "External" — the
    // canonical public site name across the workday ecosystem.
    const cdx = [
      '{"url":"https://example.wd5.myworkdayjobs.com/job/12345","status":"200","timestamp":"20260101000000"}',
      "",
    ].join("\n");
    let probedHost = "";
    const fetchFn = mock(async (input: Request | string) => {
      const url = typeof input === "string" ? input : input.url;
      if (url.includes("commoncrawl.org") && url.includes("showNumPages")) {
        return new Response("1", { status: 200 });
      }
      if (url.includes("commoncrawl.org")) return new Response(cdx, { status: 200 });
      probedHost = url;
      return new Response("ok", { status: 200 });
    });
    const result = await runHarvest({
      ats: "workday",
      snapshots: ["2026-13"],
      client: clientWith(fetchFn),
      observedAt: OBSERVED_AT,
    });
    expect(result.tenants[0]?.status).toBe("live");
    // Site stayed unset on the tenant record (we didn't promote the
    // default into stored metadata) — only host is preserved as
    // ground-truth from CDX.
    expect(result.tenants[0]?.metadata).toEqual({ host: "example.wd5.myworkdayjobs.com" });
    expect(probedHost).toContain("example.wd5.myworkdayjobs.com/External");
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

  describe("incremental mode (existingTenants)", () => {
    const OLD_PROBE = "2026-04-01T00:00:00Z";

    it("preserves existing tenant status and last_probed_at, only probes brand-new slugs", async () => {
      let probeCalls = 0;
      const fetchFn = mock(async (input: Request | string) => {
        const url = typeof input === "string" ? input : input.url;
        if (url.includes("commoncrawl.org") && url.includes("showNumPages")) {
          return new Response("1", { status: 200 });
        }
        if (url.includes("commoncrawl.org")) {
          // CDX returns the existing slug "stripe" plus a new slug "newco".
          return new Response(
            [
              '{"url":"https://boards.greenhouse.io/stripe","status":"200","timestamp":"20260101000000"}',
              '{"url":"https://boards.greenhouse.io/newco","status":"200","timestamp":"20260101000000"}',
              "",
            ].join("\n"),
            { status: 200 },
          );
        }
        // Non-CDX call must be the probe; assert which tenant it's for via URL.
        probeCalls += 1;
        return new Response("[]", { status: 200 });
      });
      const result = await runHarvest({
        ats: "greenhouse",
        snapshots: ["2026-13"],
        client: clientWith(fetchFn),
        observedAt: OBSERVED_AT,
        existingTenants: [
          {
            ats: "greenhouse",
            slug: "stripe",
            status: "live",
            last_probed_at: OLD_PROBE,
            first_seen_at: "2024-01-01T00:00:00Z",
          },
        ],
      });
      // Only the brand-new "newco" slug was probed; "stripe" kept its old probe timestamp.
      expect(probeCalls).toBe(1);
      const stripe = result.tenants.find((t) => t.slug === "stripe");
      expect(stripe?.status).toBe("live");
      expect(stripe?.last_probed_at).toBe(OLD_PROBE);
      expect(stripe?.first_seen_at).toBe("2024-01-01T00:00:00Z");
      const newco = result.tenants.find((t) => t.slug === "newco");
      expect(newco?.last_probed_at).toBe(OBSERVED_AT);
      expect(newco?.first_seen_at).toBe(OBSERVED_AT);
    });

    it("retains existing tenants that no longer appear in CDX (don't churn dead rows)", async () => {
      const fetchFn = mock(async (input: Request | string) => {
        const url = typeof input === "string" ? input : input.url;
        if (url.includes("showNumPages")) return new Response("1", { status: 200 });
        if (url.includes("commoncrawl.org")) {
          // Empty CDX page — no slugs surface in this run.
          return new Response("", { status: 200 });
        }
        return new Response("[]", { status: 200 });
      });
      const result = await runHarvest({
        ats: "greenhouse",
        snapshots: ["2026-13"],
        client: clientWith(fetchFn),
        observedAt: OBSERVED_AT,
        existingTenants: [
          {
            ats: "greenhouse",
            slug: "ghost",
            status: "dead",
            last_probed_at: OLD_PROBE,
            first_seen_at: "2024-01-01T00:00:00Z",
          },
        ],
      });
      expect(result.tenants.map((t) => t.slug)).toEqual(["ghost"]);
      expect(result.tenants[0]?.status).toBe("dead");
      expect(result.tenants[0]?.last_probed_at).toBe(OLD_PROBE);
    });

    it("backfills metadata onto an existing tenant that lacked it", async () => {
      const fetchFn = mock(async (input: Request | string) => {
        const url = typeof input === "string" ? input : input.url;
        if (url.includes("showNumPages")) return new Response("1", { status: 200 });
        if (url.includes("commoncrawl.org")) {
          return new Response(
            [
              '{"url":"https://example.wd5.myworkdayjobs.com/wday/cxs/example/External/jobs","status":"200","timestamp":"20260101000000"}',
              "",
            ].join("\n"),
            { status: 200 },
          );
        }
        return new Response("[]", { status: 200 });
      });
      const result = await runHarvest({
        ats: "workday",
        snapshots: ["2026-13"],
        client: clientWith(fetchFn),
        observedAt: OBSERVED_AT,
        existingTenants: [
          {
            ats: "workday",
            slug: "example",
            status: "transient_failure",
            last_probed_at: OLD_PROBE,
            first_seen_at: "2024-01-01T00:00:00Z",
          },
        ],
      });
      const example = result.tenants.find((t) => t.slug === "example");
      expect(example?.status).toBe("transient_failure"); // status preserved
      expect(example?.metadata?.["host"]).toBe("example.wd5.myworkdayjobs.com");
      expect(example?.metadata?.["site"]).toBe("External");
    });
  });

  describe("cdxBackend=s3", () => {
    it("routes CDX fetches through cc-s3 (cluster.idx + range block) instead of paginated HTTP", async () => {
      const { gzipSync } = await import("node:zlib");
      const cdx11 = [
        'io,greenhouse,boards)/stripe 20260101000000 {"url":"https://boards.greenhouse.io/stripe","status":"200"}',
        'io,greenhouse,boards)/anthropic 20260101000000 {"url":"https://boards.greenhouse.io/anthropic","status":"200"}',
      ].join("\n");
      const shardGz = gzipSync(Buffer.from(cdx11, "utf8"));
      const cluster = `io,greenhouse,boards)/stripe 20260101000000\tcdx-00200.gz\t0\t${shardGz.length}\t1`;

      // Track which CC URLs got hit — the HTTP path uses
      // index.commoncrawl.org with ?url=...&output=json; the S3 path
      // uses data.commoncrawl.org/cc-index/...
      const hits: string[] = [];
      const fetchFn = mock(async (input: Request | string) => {
        const url = typeof input === "string" ? input : input.url;
        hits.push(url);
        if (url.includes("data.commoncrawl.org") && url.endsWith("/cluster.idx")) {
          return new Response(cluster);
        }
        if (url.includes("data.commoncrawl.org") && url.endsWith("/cdx-00200.gz")) {
          return new Response(shardGz, { status: 206 });
        }
        // Probe URLs (greenhouse boards-api), succeed silently.
        return new Response("{}", { status: 200 });
      });

      const result = await runHarvest({
        ats: "greenhouse",
        snapshots: ["2026-17"],
        client: clientWith(fetchFn),
        observedAt: OBSERVED_AT,
        cdxBackend: "s3",
        skipProbe: true,
      });

      expect(result.unique_slugs).toBe(2);
      expect(result.tenants.map((t) => t.slug).sort()).toEqual(["anthropic", "stripe"]);
      expect(result.cdx_records).toBe(2);
      expect(result.cdx_blocks_fetched).toBe(1);
      expect(result.cdx_pages_fetched).toBe(0); // S3 path doesn't increment pages
      // No paginated HTTP calls — only the two S3 endpoints.
      expect(hits.some((u) => u.includes("index.commoncrawl.org"))).toBe(false);
      expect(hits.filter((u) => u.includes("data.commoncrawl.org")).length).toBe(2);
    });

    it("counts cluster.idx fetch failure (HttpClient-thrown HttpError) and applies adaptive backoff before next snapshot", async () => {
      // In production, HttpClient.request THROWS HttpError on persistent
      // 5xx — cc-s3 never sees a non-OK Response. Simulate that exact
      // shape: the fetchFn supplied to runHarvest goes through the real
      // HttpClient.request path, which throws on 503.
      const sleepCalls: number[] = [];
      const sleepFn = async (ms: number) => {
        sleepCalls.push(ms);
      };
      const fetchFn = mock(async (input: Request | string) => {
        const url = typeof input === "string" ? input : input.url;
        if (url.includes("data.commoncrawl.org")) {
          // First snapshot: 503 (HttpClient retries 3 times then throws).
          // Second snapshot: same. Establishes consecutiveErrors > 0.
          return new Response("server error", { status: 503 });
        }
        return new Response("{}", { status: 200 });
      });

      const result = await runHarvest({
        ats: "greenhouse",
        snapshots: ["2026-17", "2026-13"],
        client: clientWith(fetchFn),
        observedAt: OBSERVED_AT,
        cdxBackend: "s3",
        skipProbe: true,
        sleep: sleepFn,
        interPageSleepMs: 100,
      });

      expect(result.cdx_fetch_errors).toBe(2);
      expect(result.cdx_records).toBe(0);
      // Adaptive backoff should have fired before the second snapshot,
      // since the first failed. Expect at least one sleep with a value
      // ≥ baseline×2 (2^1 = 2 multiplier).
      expect(sleepCalls.some((ms) => ms >= 200)).toBe(true);
    });

    it("salvages records when one of two blocks fails (per-block recovery)", async () => {
      const { gzipSync } = await import("node:zlib");
      const cdx11 = [
        'io,greenhouse,boards)/anthropic 20260101000000 {"url":"https://boards.greenhouse.io/anthropic","status":"200"}',
      ].join("\n");
      const goodGz = gzipSync(Buffer.from(cdx11, "utf8"));
      const cluster = [
        `io,greenhouse,boards)/a 20260101000000\tcdx-00200.gz\t1000\t${goodGz.length}\t1`,
        `io,greenhouse,boards)/b 20260101000100\tcdx-00200.gz\t9999999\t100\t2`,
      ].join("\n");
      const fetchFn = mock(async (input: Request | string, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.url;
        if (url.includes("data.commoncrawl.org") && url.endsWith("/cluster.idx")) {
          return new Response(cluster);
        }
        if (url.includes("data.commoncrawl.org") && url.endsWith("/cdx-00200.gz")) {
          const range =
            (init?.headers as Record<string, string> | undefined)?.["Range"] ??
            (init?.headers as Record<string, string> | undefined)?.["range"];
          if (range?.includes("bytes=1000-")) {
            return new Response(goodGz, { status: 206 });
          }
          return new Response("nope", { status: 404 });
        }
        return new Response("{}", { status: 200 });
      });

      const result = await runHarvest({
        ats: "greenhouse",
        snapshots: ["2026-17"],
        client: clientWith(fetchFn),
        observedAt: OBSERVED_AT,
        cdxBackend: "s3",
        skipProbe: true,
      });

      // One block failed, one succeeded — should NOT mark snapshot errored
      // (we got partial results), but blocks_fetched reflects only the
      // successful one.
      expect(result.cdx_records).toBe(1);
      expect(result.cdx_blocks_fetched).toBe(1);
      expect(result.cdx_fetch_errors).toBe(0);
      expect(result.tenants.map((t) => t.slug)).toEqual(["anthropic"]);
    });
  });
});
