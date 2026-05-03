// Measure parse + filter cost only — no network throttling. Proves the
// CPU side of the slim-index plan is viable; network is a function of
// payload size which we already know (4.6 MB fresh, 16.4 MB full).
//
// Run: bun run scripts/measure-parse.ts

import { readFileSync, statSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { chromium } from "@playwright/test";
import { serve } from "bun";

interface Fixture {
  readonly name: string;
  readonly path: string;
}

const FIXTURES: ReadonlyArray<Fixture> = [
  { name: "fresh-min (190k rows)", path: "/tmp/slim/fresh-min.json" },
  { name: "full-min (747k rows)", path: "/tmp/slim/full-min.json" },
];

interface ProfileSpec {
  readonly name: string;
  readonly cpuSlowdown: number;
}

const PROFILES: ReadonlyArray<ProfileSpec> = [
  { name: "desktop CPU", cpuSlowdown: 1 },
  { name: "mid-tier mobile (4×)", cpuSlowdown: 4 },
  { name: "low-end mobile (6×)", cpuSlowdown: 6 },
];

function emit(line: string): void {
  process.stdout.write(`${line}\n`);
}

function buildPageHtml(fileName: string): string {
  return `<!doctype html>
<html><body><pre id="o"></pre><script>
(async () => {
  const o = document.getElementById("o");
  const log = (k,v) => o.textContent += k+"="+v+"\\n";
  const t0 = performance.now();
  const res = await fetch("/data/${fileName}", { cache: "no-store" });
  const buf = await res.arrayBuffer();
  const t1 = performance.now();
  log("decompressedBytes", buf.byteLength);
  const text = new TextDecoder().decode(buf);
  const t2 = performance.now();
  const obj = JSON.parse(text);
  const t3 = performance.now();
  log("decodeMs", Math.round(t2 - t1));
  log("parseMs", Math.round(t3 - t2));
  // Filter: ats=greenhouse + lv=senior, sort already by posted_at DESC at build time.
  const ai = obj.d.ats.indexOf("greenhouse");
  const li = obj.d.lv.indexOf("senior");
  const t4 = performance.now();
  let n=0;
  const top50 = [];
  for (let i = 0; i < obj.id.length && top50.length < 50; i++) {
    if (obj.a[i] === ai && obj.lv[i] === li) { top50.push(i); n++; }
  }
  const t5 = performance.now();
  log("filterMs", Math.round(t5 - t4));
  log("matches", n);
  document.body.dataset.done = "1";
})();
</script></body></html>`;
}

async function measureOne(fx: Fixture, pf: ProfileSpec, baseUrl: string): Promise<void> {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  if (pf.cpuSlowdown > 1) {
    const session = await ctx.newCDPSession(page);
    await session.send("Emulation.setCPUThrottlingRate", { rate: pf.cpuSlowdown });
  }
  const fileName = fx.path.split("/").pop() ?? "";
  const html = buildPageHtml(fileName);
  await page.route(`${baseUrl}/`, async (route) => {
    await route.fulfill({ status: 200, contentType: "text/html", body: html });
  });
  await page.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.body.dataset["done"] === "1", null, {
    timeout: 60_000,
  });
  const text = (await page.locator("#o").textContent()) ?? "";
  const kv = new Map<string, string>();
  for (const line of text.split("\n")) {
    const m = /^(\w+)=(.+)$/.exec(line);
    if (m?.[1] && m[2]) kv.set(m[1], m[2]);
  }
  const dec = Number(kv.get("decompressedBytes") ?? "0");
  emit(
    `${fx.name.padEnd(24)} ${pf.name.padEnd(22)} decompMs=${(kv.get("decodeMs") ?? "?").padStart(4)} parseMs=${(kv.get("parseMs") ?? "?").padStart(4)} filterMs=${(kv.get("filterMs") ?? "?").padStart(3)}  matches=${kv.get("matches")}  decompressed=${(dec / 1024 / 1024).toFixed(1)}MB`,
  );
  await browser.close();
}

async function main(): Promise<void> {
  const cache = new Map<string, { gz: Buffer; etag: string }>();
  for (const fx of FIXTURES) {
    const buf = readFileSync(fx.path);
    const stat = statSync(fx.path);
    cache.set(fx.path.split("/").pop() ?? "", {
      gz: gzipSync(buf, { level: 6 }),
      etag: `W/"${stat.size.toString(16)}"`,
    });
  }

  const server = serve({
    port: 0,
    fetch(req: Request): Response {
      const url = new URL(req.url);
      const m = /\/data\/([^/]+)$/.exec(url.pathname);
      if (!m) return new Response("not found", { status: 404 });
      const entry = cache.get(m[1] ?? "");
      if (!entry) return new Response("not found", { status: 404 });
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
    },
  });
  const port = (server.address as { port: number }).port;
  const baseUrl = `http://127.0.0.1:${port}`;
  emit(`server: ${baseUrl}\n`);

  for (const fx of FIXTURES) {
    for (const pf of PROFILES) {
      await measureOne(fx, pf, baseUrl);
    }
  }
  server.stop();
  process.exit(0);
}

main().catch((err: unknown) => {
  emit(`[fatal] ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exit(1);
});
