// Probe the live deployed site with a real Chromium and capture every console
// message + network failure. Lets us diagnose runtime errors without waiting
// for a full GitHub Pages redeploy cycle.
//
// With --use-local-worker, the live site's request for sqlite.worker.js is
// rewritten to serve the local public/sqlite-vfs/sqlite.worker.js instead.
// This lets us test a worker patch end-to-end against production data
// before committing & redeploying.
//
// Run: bun run scripts/probe-live.ts [url] [--use-local-worker]

/* biome-disable lint/suspicious/noConsole */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Page, type Response as PWResponse } from "@playwright/test";

const args = process.argv.slice(2);
const useLocalWorker = args.includes("--use-local-worker");
const positional = args.filter((a) => !a.startsWith("--"));
const TARGET = positional[0] ?? "https://openroles.today/";

function emit(line: string): void {
  // Single sink so we don't sprinkle biome-ignore comments at every console
  // call site. The script is a manual diagnostic; stdout is the contract.
  process.stdout.write(`${line}\n`);
}

async function attachLocalWorkerRoute(page: Page): Promise<void> {
  const localPath = join(import.meta.dirname, "..", "public", "sqlite-vfs", "sqlite.worker.js");
  const localBody = readFileSync(localPath, "utf8");
  emit(`[probe] routing worker → ${localPath} (${localBody.length} bytes)`);
  await page.route("**/sqlite-vfs/sqlite.worker.js", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/javascript; charset=utf-8",
      body: localBody,
    });
  });
}

function inspectResponse(resp: PWResponse): void {
  const status = resp.status();
  const url = resp.url();
  if (status >= 400 && status !== 416) {
    emit(`[response.error] ${status} ${url}`);
    return;
  }
  if (status === 416) {
    emit(`[response.416] ${url} range: ${resp.request().headers().range ?? ""}`);
    return;
  }
  if (status !== 206) return;
  // Detect truncated 206: client asked for bytes A-B, server returned A-C
  // where C < B. This is the signal we look for when the server-chunk
  // file is shorter than the requested range.
  const headers = resp.headers();
  const cr = headers["content-range"];
  const reqRange = resp.request().headers().range;
  if (!reqRange || !cr) return;
  const reqM = /bytes=(\d+)-(\d+)/.exec(reqRange);
  const respM = /bytes (\d+)-(\d+)\/(\d+)/.exec(cr);
  if (!reqM || !respM) return;
  const reqEnd = Number(reqM[2]);
  const respEnd = Number(respM[2]);
  if (respEnd < reqEnd) {
    emit(`[response.truncated] ${url} asked ${reqRange} got ${cr}`);
  }
}

async function main(): Promise<void> {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  if (useLocalWorker) await attachLocalWorkerRoute(page);

  let xhrCount = 0;
  page.on("console", (msg) => {
    const type = msg.type();
    const text = msg.text();
    if (text.startsWith("[xhr of size ")) {
      xhrCount += 1;
      return;
    }
    emit(`[console.${type}] ${text}`);
  });
  page.on("pageerror", (err) => {
    emit(`[pageerror] ${err.message} ${err.stack ?? ""}`);
  });
  page.on("requestfailed", (req) => {
    emit(`[requestfailed] ${req.url()} → ${req.failure()?.errorText ?? ""}`);
  });
  page.on("response", inspectResponse);
  page.on("request", (req) => {
    const url = req.url();
    if (url.includes("/data/jobs.")) {
      emit(`[req] ${url} range=${req.headers().range ?? ""}`);
    }
  });

  emit(`navigating: ${TARGET}`);
  // Don't wait for networkidle — sql.js-httpvfs keeps issuing XHRs for the
  // life of the page. domcontentloaded + the explicit wait below is enough.
  await page.goto(TARGET, { waitUntil: "domcontentloaded", timeout: 60_000 });

  // Watchdog: every 5s dump live DOM state so we can see WHEN things
  // resolve without blocking on a single waitForFunction.
  let resolved = false;
  const watchdog = setInterval(async () => {
    try {
      const snap = await page.evaluate(() => {
        const err = document.querySelector(".data-error");
        return {
          rows: document.querySelectorAll("li.job").length,
          empty: !!document.querySelector(".data-empty"),
          loading: !!document.querySelector(".data-pending"),
          error: err?.textContent?.trim() ?? null,
          status: document.querySelector(".results-status")?.textContent?.trim() ?? null,
        };
      });
      emit(`[watchdog] ${JSON.stringify(snap)}`);
      if (snap.rows > 0 || snap.error || (snap.empty && !snap.loading)) {
        resolved = true;
      }
    } catch {
      // page might be closing
    }
  }, 5_000);
  // Wait until rows render or 180s elapse.
  const start = Date.now();
  while (!resolved && Date.now() - start < 180_000) {
    await new Promise((r) => setTimeout(r, 1_000));
  }
  clearInterval(watchdog);

  const status = await page.evaluate(() => {
    const err = document.querySelector(".data-error");
    const ready = document.querySelector(".results-status")?.textContent?.trim();
    const rows = document.querySelectorAll("li.job").length;
    const empty = !!document.querySelector(".data-empty");
    const pending = !!document.querySelector(".data-pending");
    return {
      errorText: err?.textContent ?? null,
      readyText: ready ?? null,
      jobRows: rows,
      hasEmpty: empty,
      hasPending: pending,
    };
  });
  emit(`[dom-state] rows=${status.jobRows} empty=${status.hasEmpty} pending=${status.hasPending}`);
  emit(`[results-status] ${status.readyText ?? ""}`);
  emit(`[data-error] ${status.errorText ?? ""}`);
  emit(`[xhr count] ${xhrCount}`);

  await browser.close();
}

main().catch((err: unknown) => {
  emit(`[fatal] ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exit(1);
});
