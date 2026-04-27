// Lighthouse audit gated as Playwright project "lighthouse".
//
// Why Playwright over @lhci/cli: lhci is a separate harness that wants its
// own browser, its own server invocation, its own config file. Using
// playwright-lighthouse keeps the audit inside the existing Playwright
// runner — same webServer, same globalSetup (so the fixture DB is loaded),
// same reporter — and reduces the moving parts in CI. The trade-off is
// that we can't compare across runs the way lhci can; budgets are absolute,
// not delta-based.
//
// The thresholds below are tight on the things that matter (a11y, best
// practices, SEO) and conservative on performance because:
// - The first paint pulls a ~650 KB sql.js WASM blob plus a few b-tree
//   pages, which Lighthouse will count against TBT and LCP even though
//   these are out of the critical-path budget per ADR-0002.
// - The fixture site has minimal content; perf score doesn't track the
//   real production weight either way.

import { expect, test } from "@playwright/test";
import { playAudit } from "playwright-lighthouse";
import { LIGHTHOUSE_CDP_PORT, SITE_BASE } from "../../playwright.config.ts";

const INDEX = `${SITE_BASE}/`;

test.describe("Lighthouse — index page", () => {
  test("meets a11y / best-practices / SEO budgets and the perf floor", async ({ page }) => {
    test.slow(); // Lighthouse runs are 20-40s; mark explicitly.
    await page.goto(INDEX, { waitUntil: "networkidle" });
    const result = await playAudit({
      page,
      port: LIGHTHOUSE_CDP_PORT,
      thresholds: {
        performance: 60,
        accessibility: 95,
        "best-practices": 90,
        seo: 90,
      },
      disableLogs: true,
      ignoreError: false,
    });
    // playAudit throws on threshold failure, so reaching this assertion
    // already implies the budgets passed. Sanity-check the categories were
    // actually computed (i.e. Lighthouse didn't silently skip the audit).
    const categories = result.lhr.categories;
    expect(Object.keys(categories)).toEqual(
      expect.arrayContaining(["performance", "accessibility", "best-practices", "seo"]),
    );
  });
});
