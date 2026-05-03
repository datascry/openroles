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
const TARGET = positional[0] ?? "https://datascry.github.io/openroles/";

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

  emit(`navigating: ${TARGET}`);
  // Don't wait for networkidle — sql.js-httpvfs keeps issuing XHRs for the
  // life of the page. domcontentloaded + the explicit wait below is enough.
  await page.goto(TARGET, { waitUntil: "domcontentloaded", timeout: 60_000 });

  // Wait until FilterTable settles into ready (totalCount rendered) or
  // error (data-error paragraph mounted).
  try {
    await page.waitForFunction(
      () => {
        const err = document.querySelector(".data-error");
        if (err) return "error";
        const status = document.querySelector(".results-status");
        const text = status?.textContent ?? "";
        // dbStatus="loading" renders the literal LOADING… string. Once
        // dbStatus flips to "ready" the count + "PAGE n" text replaces it.
        if (text.includes("LOADING")) return false;
        if (/PAGE\s+\d+/i.test(text)) return "ready";
        return false;
      },
      null,
      { timeout: 90_000 },
    );
  } catch {
    emit("[probe] timeout waiting for db-status");
  }

  const status = await page.evaluate(() => {
    const err = document.querySelector(".data-error");
    const ready = document.querySelector(".results-status")?.textContent?.trim();
    return {
      errorText: err?.textContent ?? null,
      readyText: ready ?? null,
    };
  });
  emit(`[results-status] ${status.readyText ?? ""}`);
  emit(`[data-error] ${status.errorText ?? ""}`);
  emit(`[xhr count] ${xhrCount}`);

  await browser.close();
}

main().catch((err: unknown) => {
  emit(`[fatal] ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exit(1);
});
