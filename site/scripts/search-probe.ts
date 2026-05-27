// Drive the live site through a single search query and report what
// the FilterTable's results-status counter shows. Used to verify
// search recall against expected SQL-side counts.
//
// Run: bun run scripts/search-probe.ts <query> [base-url]

import { chromium } from "@playwright/test";
import { SITE_ORIGIN } from "../src/lib/site-config.ts";

const QUERY = process.argv[2] ?? "threat";
const TARGET = process.argv[3] ?? `${SITE_ORIGIN}/`;

function emit(line: string): void {
  process.stdout.write(`${line}\n`);
}

async function main(): Promise<void> {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();

  // Count network requests to the slim/* chunks so we know whether
  // chunks beyond #0 even land.
  const chunkRequests: { url: string; status?: number; sizeKb?: number }[] = [];
  page.on("response", (resp) => {
    const url = resp.url();
    if (!url.includes("/data/slim/")) return;
    chunkRequests.push({
      url,
      status: resp.status(),
      sizeKb: 0,
    });
  });
  emit(`navigating: ${TARGET}?q=${encodeURIComponent(QUERY)}`);
  await page.goto(`${TARGET}?q=${encodeURIComponent(QUERY)}`, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });

  // Snapshot the results-status counter at intervals so we can see
  // matches grow as chunks land + the search index loads. Also
  // captures slimIndex rows.length so we know whether more chunks
  // have merged.
  page.on("console", (msg) => {
    const t = msg.text();
    if (t.startsWith("[xhr of size ")) return;
    if (t.startsWith("constructing ") || t.startsWith("filename ") || t.startsWith("constructed "))
      return;
    emit(`  [console.${msg.type()}] ${t}`);
  });
  page.on("pageerror", (err) => emit(`  [pageerror] ${err.message}`));
  const start = Date.now();
  let lastSig = "";
  for (let i = 0; i < 90; i++) {
    const snap = await page.evaluate(() => {
      const status = document.querySelector(".results-status")?.textContent?.trim() ?? null;
      const m = status ? /(\d[\d,]*)\s+ROLES/i.exec(status) : null;
      const count = m?.[1] ? Number.parseInt(m[1].replace(/,/g, ""), 10) : null;
      const rows = document.querySelectorAll("li.job").length;
      return { status, count, rows };
    });
    const sig = `${snap.count}:${snap.rows}`;
    if (sig !== lastSig) {
      emit(
        `  t+${(Date.now() - start).toString().padStart(5)}ms  count=${snap.count}  rendered=${snap.rows}`,
      );
      lastSig = sig;
    }
    await page.waitForTimeout(1_000);
  }

  emit("");
  emit(`chunk requests captured: ${chunkRequests.length}`);
  // Bucket by status
  const byStatus = new Map<number, number>();
  for (const r of chunkRequests) {
    const s = r.status ?? 0;
    byStatus.set(s, (byStatus.get(s) ?? 0) + 1);
  }
  for (const [s, n] of byStatus) emit(`  status ${s}: ${n}`);
  if (chunkRequests.length < 5) {
    emit(`  individual urls:`);
    for (const r of chunkRequests) emit(`    ${r.status} ${r.url}`);
  }

  // Try to read in-memory state if FilterTable exposes any debug hooks
  const state = await page.evaluate(() => {
    // biome-ignore lint/suspicious/noExplicitAny: introspection
    const w = window as any;
    return {
      slimRows: w.__slimIndexRowsLength ?? null,
      slimFullyLoaded: w.__slimIndexFullyLoaded ?? null,
      bodyText: document.body.innerText.slice(0, 200),
    };
  });
  emit(`final dom-state: ${JSON.stringify(state)}`);

  await browser.close();
}

main().catch((err: unknown) => {
  emit(`[fatal] ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exit(1);
});
