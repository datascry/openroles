/**
 * End-to-end validation suite for the live deployment.
 *
 * Catches the categories of bugs that have been slipping through to
 * production and getting caught visually:
 *
 *   - hover-state contrast (text disappears on hover because background
 *     leaks into the foreground)
 *   - misleading loading-state text ("COULD NOT LOAD" while rows render)
 *   - SSR rows rendering unstyled before hydration finishes
 *   - layout shift on first paint (CLS)
 *   - cache-hit warm-reload flicker
 *   - dead static resources (favicon 404, manifest schema drift)
 *   - console errors / page errors that nobody monitors
 *
 * Usage:
 *   bun run scripts/validate-live.ts                  # against openroles.today
 *   bun run scripts/validate-live.ts https://...      # override target
 *   HEADED=1 bun run scripts/validate-live.ts         # show the browser
 *
 * Exits 0 if every check passed, 1 if any failed. Each failure prints a
 * short reason + a screenshot path under /tmp/validate-live-*.png.
 */

/* biome-disable lint/suspicious/noConsole */

import { writeFileSync } from "node:fs";
import { type Browser, chromium, type Page } from "@playwright/test";
import { SITE_ORIGIN } from "../src/lib/site-config.ts";

const TARGET = process.argv[2] ?? `${SITE_ORIGIN}/`;
const HEADED = process.env["HEADED"] === "1";
const VIEWPORT = { width: 1280, height: 900 };
const RESULTS: Result[] = [];

interface Result {
  readonly category: string;
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
  readonly screenshot?: string;
}

function report(r: Result): void {
  RESULTS.push(r);
  const mark = r.ok ? "✓" : "✗";
  process.stdout.write(
    `  ${mark} ${r.category.padEnd(10)} ${r.name.padEnd(58)} ${r.detail}${r.screenshot ? ` [${r.screenshot}]` : ""}\n`,
  );
}

// ── 1. Static HTTP probes ───────────────────────────────────────────────

async function probeHttp(): Promise<void> {
  process.stdout.write("\n[static] HTTP probes\n");
  const origin = new URL(TARGET).origin;
  const probes: Array<{
    path: string;
    expectCt?: RegExp;
    expectBodyShape?: (body: string) => string | null;
  }> = [
    { path: "/", expectCt: /text\/html/ },
    { path: "/favicon.svg", expectCt: /image\/svg/ },
    {
      path: "/data/manifest.json",
      expectCt: /application\/json/,
      expectBodyShape: (b) => {
        try {
          const m = JSON.parse(b);
          if (typeof m.short_sha !== "string") return "missing short_sha";
          if (typeof m.total_rows !== "number" || m.total_rows <= 0) return "bad total_rows";
          if (!Array.isArray(m.slim_index_chunks) || m.slim_index_chunks.length === 0)
            return "missing slim_index_chunks";
          return null;
        } catch (e) {
          return `JSON parse: ${(e as Error).message}`;
        }
      },
    },
    { path: "/robots.txt", expectCt: /text\/plain/ },
    { path: "/sitemap-index.xml", expectCt: /xml/ },
    { path: "/sw.js", expectCt: /javascript/ },
  ];
  for (const { path, expectCt, expectBodyShape } of probes) {
    try {
      const res = await fetch(`${origin}${path}`);
      const ct = res.headers.get("content-type") ?? "";
      if (!res.ok) {
        report({
          category: "static",
          name: `GET ${path}`,
          ok: false,
          detail: `HTTP ${res.status}`,
        });
        continue;
      }
      if (expectCt && !expectCt.test(ct)) {
        report({
          category: "static",
          name: `GET ${path}`,
          ok: false,
          detail: `content-type=${ct}, want ${expectCt}`,
        });
        continue;
      }
      if (expectBodyShape) {
        const body = await res.text();
        const err = expectBodyShape(body);
        if (err) {
          report({ category: "static", name: `GET ${path}`, ok: false, detail: err });
          continue;
        }
      }
      report({ category: "static", name: `GET ${path}`, ok: true, detail: `${res.status} ${ct}` });
    } catch (e) {
      report({
        category: "static",
        name: `GET ${path}`,
        ok: false,
        detail: (e as Error).message,
      });
    }
  }

  // The favicon's been bitten by `--` in XML comments before — quick
  // structural validation that the SVG is well-formed.
  try {
    const res = await fetch(`${origin}/favicon.svg`);
    const body = await res.text();
    const comments = Array.from(body.matchAll(/<!--([\s\S]*?)-->/g));
    const offending = comments.find((m) => (m[1] ?? "").includes("--"));
    if (offending) {
      report({
        category: "static",
        name: "favicon.svg is well-formed XML",
        ok: false,
        detail: "comment contains '--' (illegal in XML)",
      });
    } else {
      report({
        category: "static",
        name: "favicon.svg is well-formed XML",
        ok: true,
        detail: `${comments.length} comments OK`,
      });
    }
  } catch (e) {
    report({
      category: "static",
      name: "favicon.svg is well-formed XML",
      ok: false,
      detail: (e as Error).message,
    });
  }
}

// ── 2. Page hydration + console error monitoring ─────────────────────────

interface PageProbeContext {
  readonly page: Page;
  readonly consoleErrors: string[];
}

async function withPage<T>(
  browser: Browser,
  fn: (ctx: PageProbeContext) => Promise<T>,
  opts?: { mobile?: boolean },
): Promise<T> {
  const ctx = await browser.newContext({
    viewport: opts?.mobile ? { width: 414, height: 896 } : VIEWPORT,
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  const consoleErrors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));
  try {
    return await fn({ page, consoleErrors });
  } finally {
    await ctx.close();
  }
}

async function waitForRoles(page: Page, min = 5): Promise<void> {
  // Playwright signature: `waitForFunction(fn, arg, options)`. Earlier
  // I had `(fn, options, arg)` which silently used the default 30 s
  // timeout and ignored my 60 s — failing flaky on slow networks.
  await page.waitForFunction(
    (n: number) => document.querySelectorAll(".job-cell--role").length >= n,
    min,
    { timeout: 60_000, polling: 200 },
  );
}

async function probeHydration(browser: Browser): Promise<void> {
  process.stdout.write("\n[hydrate] page hydration + console errors\n");
  await withPage(browser, async ({ page, consoleErrors }) => {
    const res = await page.goto(TARGET, { waitUntil: "domcontentloaded", timeout: 60_000 });
    if (!res || res.status() !== 200) {
      report({
        category: "hydrate",
        name: "page loads",
        ok: false,
        detail: `HTTP ${res?.status() ?? "?"}`,
      });
      return;
    }
    try {
      await waitForRoles(page);
    } catch {
      const shot = "/tmp/validate-live-hydration-fail.png";
      await page.screenshot({ path: shot, fullPage: false });
      report({
        category: "hydrate",
        name: "rows render within 60 s",
        ok: false,
        detail: "no .job-cell--role elements",
        screenshot: shot,
      });
      return;
    }
    report({
      category: "hydrate",
      name: "rows render within 60 s",
      ok: true,
      detail: "rows visible",
    });

    // Wait a beat for fully-loaded so we capture all chunk console messages.
    await page.waitForFunction(
      () =>
        (globalThis as unknown as { __slimIndexFullyLoaded?: boolean }).__slimIndexFullyLoaded ===
        true,
      null,
      { timeout: 90_000, polling: 500 },
    );

    // Filter out expected noise (favicon 404 on dev preview, SW DevTools
    // warnings on CI runners, etc.). Anything else suggests a real bug.
    const fatalErrors = consoleErrors.filter(
      (e) =>
        !/favicon\.ico.*404/i.test(e) &&
        !/no live manifest/i.test(e) &&
        !/cookie/i.test(e) &&
        !/Failed to load resource.*404.*favicon/i.test(e),
    );
    if (fatalErrors.length > 0) {
      report({
        category: "hydrate",
        name: "no fatal console errors",
        ok: false,
        detail: fatalErrors.slice(0, 2).join(" | ").slice(0, 200),
      });
    } else {
      report({
        category: "hydrate",
        name: "no fatal console errors",
        ok: true,
        detail: `${consoleErrors.length} non-fatal logged`,
      });
    }
  });
}

// ── 3. Layout shift (CLS) measurement ────────────────────────────────────

async function probeCls(browser: Browser, label: string, mobile = false): Promise<void> {
  await withPage(
    browser,
    async ({ page }) => {
      await page.addInitScript(() => {
        const w = window as unknown as {
          __cls: number;
          __clsEntries: Array<{ t: number; v: number; sources: string[] }>;
        };
        w.__cls = 0;
        w.__clsEntries = [];
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries() as unknown as Array<{
            hadRecentInput: boolean;
            value: number;
            startTime: number;
            sources?: Array<{ node?: Element }>;
          }>) {
            if (entry.hadRecentInput) continue;
            w.__cls += entry.value;
            w.__clsEntries.push({
              t: Math.round(entry.startTime),
              v: Number(entry.value.toFixed(4)),
              sources: (entry.sources ?? [])
                .map((s) => {
                  if (!s.node) return "?";
                  const el = s.node as Element;
                  const cls =
                    el.className && typeof el.className === "string"
                      ? `.${el.className.split(" ")[0]}`
                      : "";
                  const id = el.id ? `#${el.id}` : "";
                  return `${el.tagName.toLowerCase()}${id}${cls}`;
                })
                .slice(0, 3),
            });
          }
        }).observe({ type: "layout-shift", buffered: true });
      });
      await page.goto(TARGET, { waitUntil: "commit", timeout: 60_000 });
      await waitForRoles(page);
      await page.waitForTimeout(1500);
      const cls = await page.evaluate(() => {
        const w = window as unknown as {
          __cls: number;
          __clsEntries: Array<{ t: number; v: number; sources: string[] }>;
        };
        return { total: Number(w.__cls.toFixed(4)), entries: w.__clsEntries };
      });
      const ok = cls.total < 0.1;
      const sources = cls.entries
        .filter((e) => e.v > 0.001)
        .map((e) => `t=${e.t}:${e.v} ${e.sources.join(",")}`)
        .slice(0, 2)
        .join(" | ");
      report({
        category: "cls",
        name: `CLS ${label} (< 0.1)`,
        ok,
        detail: `total=${cls.total}${sources ? ` — ${sources}` : ""}`,
      });
    },
    { mobile },
  );
}

// ── 4. Hover-state contrast validation ───────────────────────────────────

function parseRgb(s: string): [number, number, number] | null {
  const m = s.match(/rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  const toLinear = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

function contrastRatio(fg: [number, number, number], bg: [number, number, number]): number {
  const l1 = relativeLuminance(fg);
  const l2 = relativeLuminance(bg);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

async function probeHoverContrast(browser: Browser): Promise<void> {
  process.stdout.write("\n[hover] hover-state contrast\n");
  // Element selector + a label-element-selector to read text from. Most
  // are the same; chips contain text directly. Some (.job-action.save /
  // .ignore / .apply) wrap their visible glyph in a child span.
  // `optional: true` means absence is not a failure (the element only
  // exists in certain UI states, e.g. .active-chip after a filter is
  // applied). The probe still runs if the element is present.
  const targets: Array<{
    name: string;
    selector: string;
    textSelector?: string;
    optional?: boolean;
  }> = [
    { name: "filter chip (workplace)", selector: ".chip:not(.is-active)" },
    { name: "filter chip (POSTED group)", selector: ".chip.is-active" },
    { name: "group header button (WORKPLACE etc.)", selector: ".group-header-button" },
    { name: "active filter chip in filter-bar", selector: ".active-chip", optional: true },
    { name: "save button (★ glyph)", selector: ".job-action.save" },
    { name: "ignore button (× glyph)", selector: ".job-action.ignore" },
    { name: "apply button", selector: ".job-action.apply" },
    { name: "search-bar tab (FREE TEXT / STRUCTURED)", selector: ".tab" },
    { name: "theme toggle in masthead", selector: ".theme-toggle" },
  ];

  await withPage(browser, async ({ page }) => {
    await page.goto(TARGET, { waitUntil: "commit", timeout: 60_000 });
    await waitForRoles(page);
    await page.waitForTimeout(500);

    for (const t of targets) {
      try {
        const el = page.locator(t.selector).first();
        const present = await el.count();
        if (present === 0) {
          report({
            category: "hover",
            name: t.name,
            ok: t.optional === true,
            detail: t.optional
              ? `(optional) ${t.selector} not present in current UI state`
              : `selector ${t.selector} not found`,
          });
          continue;
        }
        // Resolve the text element — usually the element itself; some
        // buttons wrap content in a span.
        const textEl = t.textSelector ? el.locator(t.textSelector).first() : el;
        await el.hover({ trial: false });
        await page.waitForTimeout(120);
        const sample = await textEl.evaluate((el) => {
          // Walk up to the nearest element with a non-transparent
          // background; if all ancestors are transparent, use body.
          const fg = getComputedStyle(el).color;
          let cursor: Element | null = el;
          let bg = "rgba(0, 0, 0, 0)";
          while (cursor) {
            const bgc = getComputedStyle(cursor).backgroundColor;
            if (!/rgba?\([^)]*?,\s*0\s*\)$/.test(bgc) && bgc !== "rgba(0, 0, 0, 0)") {
              bg = bgc;
              break;
            }
            cursor = cursor.parentElement;
          }
          if (bg === "rgba(0, 0, 0, 0)") {
            bg = getComputedStyle(document.body).backgroundColor;
          }
          return { fg, bg };
        });
        const fgRgb = parseRgb(sample.fg);
        const bgRgb = parseRgb(sample.bg);
        if (!fgRgb || !bgRgb) {
          report({
            category: "hover",
            name: t.name,
            ok: false,
            detail: `could not parse colors fg=${sample.fg} bg=${sample.bg}`,
          });
          continue;
        }
        const ratio = contrastRatio(fgRgb, bgRgb);
        // WCAG AA for normal text = 4.5:1; large text = 3:1. We're
        // strict here — all hover states should clear 4.5 in both
        // themes so we don't ship something that's "technically AA for
        // big text" but still feels wrong.
        const ok = ratio >= 4.5;
        const screenshot = ok
          ? undefined
          : `/tmp/validate-live-hover-${t.name.replace(/[^a-z0-9]/gi, "-")}.png`;
        if (screenshot) {
          await page.screenshot({ path: screenshot, fullPage: false });
        }
        report({
          category: "hover",
          name: t.name,
          ok,
          detail: `ratio=${ratio.toFixed(2)} (${sample.fg} on ${sample.bg})`,
          ...(screenshot ? { screenshot } : {}),
        });
        // Un-hover by moving the mouse to a known-empty spot
        await page.mouse.move(5, 5);
        await page.waitForTimeout(50);
      } catch (e) {
        report({
          category: "hover",
          name: t.name,
          ok: false,
          detail: (e as Error).message.slice(0, 100),
        });
      }
    }
  });
}

// ── 5. Loading-state coherence ───────────────────────────────────────────

async function probeLoadingCoherence(browser: Browser): Promise<void> {
  process.stdout.write("\n[loading] loading-state text coherence\n");
  // Confirm the status text never says "COULD NOT LOAD" while rows are
  // visible. Caught a real bug in PR #90 where loading-progressive
  // fell through to the error branch.
  await withPage(browser, async ({ page }) => {
    await page.route("**/data/slim/**", async (route) => {
      await new Promise((r) => setTimeout(r, 3000));
      await route.continue();
    });
    await page.goto(TARGET, { waitUntil: "commit", timeout: 60_000 });
    const violations: string[] = [];
    for (let t = 100; t < 6000; t += 300) {
      await page.waitForTimeout(300);
      const snap = await page.evaluate(() => {
        const status = document.querySelector(".results-status")?.textContent ?? "";
        const rowCount = document.querySelectorAll(".job-cell--role").length;
        return { status: status.trim().replace(/\s+/g, " "), rowCount };
      });
      if (/could not load/i.test(snap.status) && snap.rowCount > 0) {
        violations.push(
          `t=${t}ms: status "${snap.status.slice(0, 50)}" while ${snap.rowCount} rows visible`,
        );
      }
    }
    if (violations.length > 0) {
      report({
        category: "loading",
        name: "no 'COULD NOT LOAD' while rows visible",
        ok: false,
        detail: violations[0] ?? "?",
      });
    } else {
      report({
        category: "loading",
        name: "no 'COULD NOT LOAD' while rows visible",
        ok: true,
        detail: "status + rows consistent across load",
      });
    }
  });
}

// ── 6. SSR pre-paint rows render styled ─────────────────────────────────

async function probeSsrStyled(browser: Browser): Promise<void> {
  process.stdout.write("\n[ssr] SSR pre-paint row styling\n");
  await withPage(browser, async ({ page }) => {
    // Throttle chunks heavily so SSR rows are visible for a long
    // sampling window. We DON'T throttle the main HTML or JS — we
    // want the page to render and JS to hydrate quickly.
    await page.route("**/data/slim/**", async (route) => {
      await new Promise((r) => setTimeout(r, 5000));
      await route.continue();
    });
    await page.goto(TARGET, { waitUntil: "commit", timeout: 60_000 });
    // The SSR aside is removed by FilterTable's $effect once rows
    // populate. Capture styles BEFORE that, while the SSR aside is
    // still in DOM. We have a small window — but if styles are
    // applied via global CSS (the recent fix), the FilterTable's own
    // rows look the same so we can sample whichever is present.
    await page.waitForFunction(
      () => document.querySelector("#first-paint-rows li.job, astro-island li.job") !== null,
      null,
      { timeout: 10_000, polling: 50 },
    );
    // Sample styles across a 1 s window. The first sample on a fresh
    // browser context can race the CSS download — we only want to
    // flag a real persistent FOUC, not a one-frame transient. Use
    // the LAST sample as the verdict (by which time CSS has surely
    // loaded if it's going to).
    let snap: {
      source: string;
      rowDisplay: string;
      titleColor: string | null;
      titleFontSize: string | null;
      titleTextTransform: string | null;
      companyColor: string | null;
      applyBg: string | null;
    } | null = null;
    for (let i = 0; i < 5; i++) {
      snap = await page.evaluate(() => {
        const row =
          document.querySelector("#first-paint-rows li.job") ??
          document.querySelector("astro-island li.job");
        if (!row) return null;
        const title = row.querySelector(".job-title");
        const company = row.querySelector(".company");
        const apply = row.querySelector(".job-action.apply");
        return {
          source: row.closest("#first-paint-rows") ? "SSR aside" : "Svelte island",
          rowDisplay: getComputedStyle(row).display,
          titleColor: title ? getComputedStyle(title).color : null,
          titleFontSize: title ? getComputedStyle(title).fontSize : null,
          titleTextTransform: title ? getComputedStyle(title).textTransform : null,
          companyColor: company ? getComputedStyle(company).color : null,
          applyBg: apply ? getComputedStyle(apply).backgroundColor : null,
        };
      });
      // Early exit if styles already applied — saves up to 800 ms.
      if (snap && snap.rowDisplay === "grid") break;
      await page.waitForTimeout(200);
    }
    if (!snap) {
      report({ category: "ssr", name: "row styles applied", ok: false, detail: "no row found" });
      return;
    }
    // Known good signatures:
    //   - title font-size > 24 px (display sans, not browser default 16 px)
    //   - title color != default link blue (rgb(0, 0, 238))
    //   - company color matches accent-red family
    //   - apply has non-transparent bg (the brand button, not a plain link)
    const issues: string[] = [];
    if (snap.titleFontSize && parseFloat(snap.titleFontSize) < 20) {
      issues.push(`title fontSize=${snap.titleFontSize}, want ≥ 20 px`);
    }
    if (snap.titleColor === "rgb(0, 0, 238)") {
      issues.push("title is default browser link blue");
    }
    if (snap.rowDisplay === "list-item") {
      issues.push(`row display=${snap.rowDisplay}, want grid`);
    }
    if (snap.applyBg === "rgba(0, 0, 0, 0)" || snap.applyBg === "transparent") {
      issues.push(`apply bg is transparent, want accent`);
    }
    if (issues.length > 0) {
      const shot = "/tmp/validate-live-ssr-unstyled.png";
      await page.screenshot({ path: shot, fullPage: false });
      report({
        category: "ssr",
        name: "row styles applied",
        ok: false,
        detail: `(${snap.source}) ${issues.join("; ")}`,
        screenshot: shot,
      });
    } else {
      report({
        category: "ssr",
        name: "row styles applied",
        ok: true,
        detail: `(${snap.source}) title=${snap.titleFontSize}/${snap.titleColor}, apply.bg=${snap.applyBg}`,
      });
    }
  });
}

// ── 7. Service Worker registers + caches ─────────────────────────────────

async function probeServiceWorker(browser: Browser): Promise<void> {
  process.stdout.write("\n[sw] service worker registration + cache hit on reload\n");
  await withPage(browser, async ({ page }) => {
    await page.goto(TARGET, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await waitForRoles(page);
    await page.waitForTimeout(2000);
    const swInfo = await page.evaluate(async () => {
      if (!("serviceWorker" in navigator)) return { supported: false };
      const regs = await navigator.serviceWorker.getRegistrations();
      return {
        supported: true,
        scopes: regs.map((r) => r.scope),
      };
    });
    if (!swInfo.supported || (swInfo.scopes?.length ?? 0) === 0) {
      report({
        category: "sw",
        name: "registered with correct scope",
        ok: false,
        detail: "no service worker registrations",
      });
      return;
    }
    const expected = `${new URL(TARGET).origin}/`;
    const ok = swInfo.scopes?.includes(expected);
    report({
      category: "sw",
      name: "registered with correct scope",
      ok,
      detail: `scopes=${JSON.stringify(swInfo.scopes)}, expected ${expected}`,
    });

    // Now wait for the cache to populate, then reload and check that
    // the warm-reload IDB cache hit makes the merged rows available
    // quickly (the perf optimization in PR #86).
    await page.waitForFunction(
      () =>
        (globalThis as unknown as { __slimIndexFullyLoaded?: boolean }).__slimIndexFullyLoaded ===
        true,
      null,
      { timeout: 90_000, polling: 500 },
    );
    const t0 = Date.now();
    await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
    await waitForRoles(page);
    const interactiveAt = Date.now() - t0;
    // Cache hit should resolve in ~100-300ms. Anything past 2s means
    // the IDB cache isn't engaging.
    const cacheOk = interactiveAt < 2000;
    report({
      category: "sw",
      name: "warm reload restores from IDB cache (< 2 s)",
      ok: cacheOk,
      detail: `interactive in ${interactiveAt} ms`,
    });
  });
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  process.stdout.write(`\nValidate live: ${TARGET}\n`);
  process.stdout.write(`Viewport: ${VIEWPORT.width}×${VIEWPORT.height}, headless: ${!HEADED}\n`);

  await probeHttp();

  const browser = await chromium.launch({ headless: !HEADED });
  try {
    // Each probe is wrapped so a single failure doesn't kill the run.
    // We want a complete report card, not a fail-fast.
    const safelyRun = async (fn: () => Promise<void>, label: string) => {
      try {
        await fn();
      } catch (e) {
        report({
          category: "harness",
          name: label,
          ok: false,
          detail: `probe crashed: ${(e as Error).message.slice(0, 200)}`,
        });
      }
    };
    await safelyRun(() => probeHydration(browser), "probeHydration");
    await safelyRun(() => probeServiceWorker(browser), "probeServiceWorker");
    await safelyRun(() => probeSsrStyled(browser), "probeSsrStyled");
    await safelyRun(() => probeLoadingCoherence(browser), "probeLoadingCoherence");
    await safelyRun(() => probeCls(browser, "desktop"), "probeCls desktop");
    await safelyRun(() => probeCls(browser, "mobile", true), "probeCls mobile");
    await safelyRun(() => probeHoverContrast(browser), "probeHoverContrast");
  } finally {
    await browser.close();
  }

  const failed = RESULTS.filter((r) => !r.ok);
  const ok = RESULTS.length - failed.length;
  process.stdout.write(
    `\n${ok}/${RESULTS.length} checks passed${failed.length > 0 ? `, ${failed.length} failed:` : ""}\n`,
  );
  for (const f of failed) {
    process.stdout.write(`  ✗ [${f.category}] ${f.name} — ${f.detail}\n`);
    if (f.screenshot) process.stdout.write(`        screenshot: ${f.screenshot}\n`);
  }

  // Dump a machine-readable summary for CI consumers.
  writeFileSync(
    "/tmp/validate-live-report.json",
    JSON.stringify({ target: TARGET, results: RESULTS }, null, 2),
  );

  process.exit(failed.length === 0 ? 0 : 1);
}

await main();
