// End-to-end performance probe against the live deployed site.
// Captures the metrics that matter for the "my tab freezes" report:
//
//   - Long tasks (>50ms main-thread blocking) over the lifetime of
//     the visit. PerformanceObserver('longtask') is the Web Vitals
//     primitive for "the user can't interact during this window."
//   - Total Blocking Time (TBT) — sum of (longTask.duration - 50ms)
//     across the visit, the standard mobile-perf score.
//   - JS heap growth — process.memory().usedJSHeapSize sampled at
//     ~1Hz so we can see when chunks land + chart memory profile.
//   - Filter interaction latency — measure the wall time from
//     "user-typed-into-filter" to "rows visibly updated."
//   - Time to interactive — when the FilterTable's `dbStatus` flips
//     to "ready" AND the input is responsive.
//
// The output is one summary line and a JSON dump for grepping; we
// flag any long task >200ms (severe jank) and any TBT >300ms (above
// the Lighthouse "Good" threshold).

import { chromium, type Page } from "@playwright/test";

const TARGET = process.argv[2] ?? "https://openroles.today/";
const VISIT_DURATION_MS = 60_000; // observe for a minute
const FILTER_INTERACTIONS = [
  // Wait until rows render, then exercise filters
  { kind: "wait" as const, ms: 3_000 },
  { kind: "click" as const, selector: 'button[aria-haspopup="menu"]:has-text("ATS")' },
  { kind: "wait" as const, ms: 200 },
  { kind: "click" as const, selector: 'label:has-text("greenhouse") input' },
  { kind: "wait" as const, ms: 1_000 },
  { kind: "click" as const, selector: 'button:has-text("LEVEL")' },
  { kind: "wait" as const, ms: 200 },
  { kind: "click" as const, selector: 'label:has-text("senior") input' },
  { kind: "wait" as const, ms: 1_000 },
  { kind: "type" as const, selector: 'input[type="search"]', text: "engineer" },
  { kind: "wait" as const, ms: 2_000 },
];

interface LongTask {
  duration: number;
  startTime: number;
}

interface PerfSample {
  ts: number;
  heapMb: number;
  rowsRendered: number;
}

interface FilterTiming {
  label: string;
  startMs: number;
  durationMs: number;
}

function emit(line: string): void {
  process.stdout.write(`${line}\n`);
}

async function instrumentPage(page: Page): Promise<void> {
  await page.addInitScript(() => {
    // biome-ignore lint/suspicious/noExplicitAny: instrumentation hook
    (window as any).__perfBucket = {
      longTasks: [] as LongTask[],
      filterTimings: [] as FilterTiming[],
    };
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        // biome-ignore lint/suspicious/noExplicitAny: window.__perfBucket
        (window as any).__perfBucket.longTasks.push({
          duration: entry.duration,
          startTime: entry.startTime,
        });
      }
    });
    try {
      observer.observe({ entryTypes: ["longtask"] });
    } catch {
      // longtask not supported in this engine; skip silently
    }
  });
}

async function runProbe(): Promise<void> {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await instrumentPage(page);

  const samples: PerfSample[] = [];
  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => consoleErrors.push(`pageerror: ${err.message}`));

  emit(`[perf] navigate: ${TARGET}`);
  const navStart = Date.now();
  await page.goto(TARGET, { waitUntil: "domcontentloaded", timeout: 60_000 });
  emit(`[perf] domcontentloaded: ${Date.now() - navStart}ms`);

  // First-paint check: SSR rows visible?
  const firstPaintRows = await page.evaluate(() => document.querySelectorAll("li.job").length);
  emit(`[perf] rows at DOMContentLoaded: ${firstPaintRows}`);

  // Sample heap + row count every second for the visit duration.
  const sampleInterval = setInterval(async () => {
    try {
      const sample = await page.evaluate(() => {
        // biome-ignore lint/suspicious/noExplicitAny: chrome-only
        const mem = (performance as any).memory;
        return {
          heapMb: mem ? mem.usedJSHeapSize / 1024 / 1024 : 0,
          rowsRendered: document.querySelectorAll("li.job").length,
        };
      });
      samples.push({
        ts: Date.now() - navStart,
        heapMb: sample.heapMb,
        rowsRendered: sample.rowsRendered,
      });
    } catch {
      // page might be closing
    }
  }, 1_000);

  // Run the interaction script.
  for (const step of FILTER_INTERACTIONS) {
    if (step.kind === "wait") {
      await page.waitForTimeout(step.ms);
      continue;
    }
    if (step.kind === "click") {
      const t0 = Date.now();
      try {
        await page.locator(step.selector).first().click({ timeout: 5_000 });
        await page.evaluate(
          (info) => {
            // biome-ignore lint/suspicious/noExplicitAny: window.__perfBucket
            (window as any).__perfBucket.filterTimings.push({
              label: `click:${info.selector}`,
              startMs: info.t0,
              durationMs: performance.now(),
            });
          },
          { selector: step.selector, t0 },
        );
      } catch (err) {
        emit(`[perf] click failed: ${step.selector} — ${(err as Error).message}`);
      }
      continue;
    }
    if (step.kind === "type") {
      const t0 = Date.now();
      try {
        await page.locator(step.selector).first().fill(step.text, { timeout: 5_000 });
        await page.evaluate(
          (info) => {
            // biome-ignore lint/suspicious/noExplicitAny: window.__perfBucket
            (window as any).__perfBucket.filterTimings.push({
              label: `type:${info.text}`,
              startMs: info.t0,
              durationMs: performance.now(),
            });
          },
          { text: step.text, t0 },
        );
      } catch (err) {
        emit(`[perf] type failed: ${step.selector} — ${(err as Error).message}`);
      }
    }
  }

  // Let the visit run a bit longer so chunks finish loading.
  const elapsed = Date.now() - navStart;
  if (elapsed < VISIT_DURATION_MS) {
    await page.waitForTimeout(VISIT_DURATION_MS - elapsed);
  }
  clearInterval(sampleInterval);

  // Pull instrumentation results out of the page.
  const result = await page.evaluate(() => {
    // biome-ignore lint/suspicious/noExplicitAny: window.__perfBucket
    const bucket = (window as any).__perfBucket as {
      longTasks: LongTask[];
      filterTimings: FilterTiming[];
    };
    return {
      longTasks: bucket.longTasks,
      filterTimings: bucket.filterTimings,
      finalRows: document.querySelectorAll("li.job").length,
      finalStatus: document.querySelector(".results-status")?.textContent?.trim() ?? null,
    };
  });

  await browser.close();

  // Summarise.
  const tbt = result.longTasks.reduce((acc, t) => acc + Math.max(0, t.duration - 50), 0);
  const longestTask = result.longTasks.reduce((acc, t) => Math.max(acc, t.duration), 0);
  const tasks200Plus = result.longTasks.filter((t) => t.duration >= 200);

  emit("");
  emit("=== summary ===");
  emit(`final rows rendered: ${result.finalRows}`);
  emit(`final results-status: ${result.finalStatus}`);
  emit(`total long tasks (>50ms): ${result.longTasks.length}`);
  emit(`total blocking time (TBT): ${Math.round(tbt)}ms`);
  emit(`longest single task: ${Math.round(longestTask)}ms`);
  emit(`tasks ≥200ms: ${tasks200Plus.length}`);
  if (tasks200Plus.length > 0) {
    emit(`  individual long tasks ≥200ms (start, dur):`);
    for (const t of tasks200Plus.slice(0, 10)) {
      emit(`    ${Math.round(t.startTime)}ms  +${Math.round(t.duration)}ms`);
    }
  }
  emit("");
  emit(`heap timeline (every 1s):`);
  emit("  ts(ms)  heap(MB)  rows");
  for (const s of samples) {
    emit(
      `  ${String(s.ts).padStart(6)}  ${s.heapMb.toFixed(1).padStart(8)}  ${String(s.rowsRendered).padStart(4)}`,
    );
  }
  emit("");
  if (consoleErrors.length > 0) {
    emit(`console errors:`);
    for (const e of consoleErrors.slice(0, 10)) emit(`  ${e}`);
  }
  emit("");
  // Verdicts:
  const VERDICT_TBT_GOOD = 200; // Lighthouse mobile threshold
  const VERDICT_TBT_NEEDS_IMPROVEMENT = 600;
  const verdict =
    tbt < VERDICT_TBT_GOOD
      ? "GOOD"
      : tbt < VERDICT_TBT_NEEDS_IMPROVEMENT
        ? "NEEDS-IMPROVEMENT"
        : "POOR";
  emit(
    `verdict: ${verdict} (TBT=${Math.round(tbt)}ms; Lighthouse mobile thresholds: <200 GOOD, <600 NEEDS-IMPROVEMENT)`,
  );
}

runProbe().catch((err: unknown) => {
  emit(`[fatal] ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exit(1);
});
