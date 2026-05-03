// Validate the Option-B slim-index transport plan end-to-end before
// committing build infrastructure to it. We spin up a local Bun
// server that mimics GitHub Pages / Fastly behavior on JSON
// (auto-gzip with vary, content-length, cache-control max-age=600,
// weak ETag), point Playwright at it under mobile network/CPU
// throttling, and measure: download time, decompress + parse time,
// and the cost of running representative filter queries on the
// in-memory index.
//
// The fixture must already exist on disk at /tmp/slim/fresh-min.json
// and /tmp/slim/full-min.json (built via the SoA dictionary script).
//
// Run: bun run scripts/validate-slim-index.ts

import { readFileSync, statSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { chromium } from "@playwright/test";
import { serve } from "bun";

interface Fixture {
  readonly name: string;
  readonly path: string;
}

const FIXTURES: ReadonlyArray<Fixture> = [
  { name: "fresh-min (30d window, ~190k rows)", path: "/tmp/slim/fresh-min.json" },
  { name: "full-min (all 747k rows)", path: "/tmp/slim/full-min.json" },
];

interface ProfileSpec {
  readonly name: string;
  /** Bytes/sec inbound throttle. Chromium's NetworkConditions is in bytes/sec. */
  readonly downloadBps: number;
  readonly latencyMs: number;
  /** CPU throttle multiplier (Chromium DevTools Protocol). */
  readonly cpuSlowdown: number;
}

const PROFILES: ReadonlyArray<ProfileSpec> = [
  // Mid-tier 4G in EU/US
  { name: "mid 4G", downloadBps: 4_000_000 / 8, latencyMs: 50, cpuSlowdown: 4 },
  // Slow 4G in emerging markets, indoor coverage
  { name: "slow 4G", downloadBps: 1_500_000 / 8, latencyMs: 150, cpuSlowdown: 4 },
  // 3G fallback
  { name: "fast 3G", downloadBps: 750_000 / 8, latencyMs: 200, cpuSlowdown: 6 },
  // Desktop baseline (no throttle)
  { name: "desktop", downloadBps: 0, latencyMs: 0, cpuSlowdown: 1 },
];

function emit(line: string): void {
  process.stdout.write(`${line}\n`);
}

interface MeasureResult {
  readonly fixture: string;
  readonly profile: string;
  readonly transferBytes: number;
  readonly fetchMs: number;
  readonly parseMs: number;
  readonly filterMs: number;
  readonly totalMs: number;
}

async function measureOne(
  fixture: Fixture,
  profile: ProfileSpec,
  baseUrl: string,
): Promise<MeasureResult> {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  // Apply throttling via CDP — Playwright wraps it under emulateNetwork.
  if (profile.downloadBps > 0) {
    const session = await ctx.newCDPSession(page);
    await session.send("Network.enable");
    await session.send("Network.emulateNetworkConditions", {
      offline: false,
      downloadThroughput: profile.downloadBps,
      uploadThroughput: profile.downloadBps,
      latency: profile.latencyMs,
    });
    await session.send("Emulation.setCPUThrottlingRate", { rate: profile.cpuSlowdown });
  }

  const url = `${baseUrl}/data/${fixture.path.split("/").pop()}`;
  const html = `<!doctype html>
<html><head><meta charset="utf-8"></head>
<body><pre id="out"></pre><script>
(async () => {
  const out = document.getElementById("out");
  const log = (k,v) => out.textContent += k + "=" + v + "\\n";

  const t0 = performance.now();
  const res = await fetch(${JSON.stringify(url)}, { cache: "no-store" });
  const buf = await res.arrayBuffer();
  const t1 = performance.now();
  log("fetchMs", Math.round(t1 - t0));
  log("transferBytes", buf.byteLength);

  // The browser handles Content-Encoding: gzip automatically — buf is
  // already the decompressed JSON body.
  const text = new TextDecoder().decode(buf);
  const t2 = performance.now();
  const obj = JSON.parse(text);
  const t3 = performance.now();
  log("decodeMs", Math.round(t2 - t1));
  log("parseMs", Math.round(t3 - t2));

  // Realistic filter: WHERE ats === "greenhouse" AND lv === senior, sort posted_at DESC, take top 50.
  const atsIdx = obj.d.ats.indexOf("greenhouse");
  const lvIdx = obj.d.lv.indexOf("senior");
  const t4 = performance.now();
  const matches = [];
  for (let i = 0; i < obj.id.length; i++) {
    if (obj.a[i] === atsIdx && obj.lv[i] === lvIdx) matches.push(i);
  }
  // Already sorted by posted_at DESC at build time, so just take top 50.
  const top50 = matches.slice(0, 50);
  const t5 = performance.now();
  log("matches", matches.length);
  log("filterMs", Math.round(t5 - t4));
  log("totalMs", Math.round(t5 - t0));
  document.body.dataset.done = "1";
})();
</script></body></html>`;

  await page.route(`${baseUrl}/`, async (route) => {
    await route.fulfill({ status: 200, contentType: "text/html", body: html });
  });

  await page.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.body.dataset["done"] === "1", null, {
    timeout: 300_000,
  });
  const text = (await page.locator("#out").textContent()) ?? "";
  await browser.close();

  const kv = new Map<string, string>();
  for (const line of text.split("\n")) {
    const m = /^(\w+)=(.+)$/.exec(line);
    if (m?.[1] && m[2]) kv.set(m[1], m[2]);
  }
  return {
    fixture: fixture.name,
    profile: profile.name,
    transferBytes: Number(kv.get("transferBytes") ?? "0"),
    fetchMs: Number(kv.get("fetchMs") ?? "0"),
    parseMs: Number(kv.get("parseMs") ?? "0") + Number(kv.get("decodeMs") ?? "0"),
    filterMs: Number(kv.get("filterMs") ?? "0"),
    totalMs: Number(kv.get("totalMs") ?? "0"),
  };
}

async function main(): Promise<void> {
  // Pre-gzip every fixture once so per-request handling is just a buffer
  // copy. Pages' on-the-fly gzip would be similar from the wire's POV.
  const cache = new Map<string, { raw: Buffer; gz: Buffer; etag: string }>();
  for (const fx of FIXTURES) {
    const buf = readFileSync(fx.path);
    const stat = statSync(fx.path);
    cache.set(fx.path.split("/").pop() ?? "", {
      raw: buf,
      gz: gzipSync(buf, { level: 6 }),
      etag: `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`,
    });
  }
  emit(`pre-gzipped fixtures: ${[...cache.keys()].join(", ")}`);

  // Spin up a Bun server that imitates Pages' header behavior on JSON.
  const server = serve({
    port: 0,
    fetch(req: Request): Response {
      const url = new URL(req.url);
      const m = /\/data\/([^/]+)$/.exec(url.pathname);
      if (!m) return new Response("not found", { status: 404 });
      const entry = cache.get(m[1] ?? "");
      if (!entry) return new Response("not found", { status: 404 });
      const acceptsGzip = (req.headers.get("accept-encoding") ?? "").includes("gzip");
      if (acceptsGzip) {
        return new Response(entry.gz, {
          status: 200,
          headers: {
            "content-type": "application/json; charset=utf-8",
            "content-encoding": "gzip",
            "content-length": String(entry.gz.length),
            vary: "Accept-Encoding",
            "cache-control": "max-age=600",
            etag: entry.etag,
          },
        });
      }
      return new Response(entry.raw, {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "content-length": String(entry.raw.length),
          "cache-control": "max-age=600",
          etag: entry.etag,
        },
      });
    },
  });
  const port = (server.address as { port: number }).port;
  const baseUrl = `http://127.0.0.1:${port}`;
  emit(`server: ${baseUrl}`);
  emit("");

  const results: MeasureResult[] = [];
  for (const fx of FIXTURES) {
    for (const pf of PROFILES) {
      emit(`measuring ${fx.name} on ${pf.name}…`);
      const r = await measureOne(fx, pf, baseUrl);
      results.push(r);
      const otw = `${(r.transferBytes / 1024 / 1024).toFixed(2)} MB`;
      emit(
        `  → fetch=${r.fetchMs}ms parse=${r.parseMs}ms filter=${r.filterMs}ms total=${r.totalMs}ms (otw=${otw})`,
      );
    }
  }

  emit("\n=== results ===");
  emit(
    "fixture                                profile     bytes-OTW   fetch    parse   filter    total",
  );
  for (const r of results) {
    const otw = `${(r.transferBytes / 1024 / 1024).toFixed(2)} MB`;
    emit(
      `${r.fixture.padEnd(38)} ${r.profile.padEnd(10)} ${otw.padStart(10)}   ${`${r.fetchMs}ms`.padStart(7)}   ${`${r.parseMs}ms`.padStart(5)}   ${`${r.filterMs}ms`.padStart(5)}   ${`${r.totalMs}ms`.padStart(6)}`,
    );
  }

  server.stop();
  process.exit(0);
}

main().catch((err: unknown) => {
  emit(`[fatal] ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exit(1);
});
