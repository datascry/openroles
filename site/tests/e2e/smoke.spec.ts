import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { SITE_BASE } from "../../playwright.config.ts";

const INDEX = `${SITE_BASE}/`;
const FEED = `${SITE_BASE}/feed.xml`;

test.describe("index page smoke", () => {
  test("renders the page chrome and a status line", async ({ page }) => {
    await page.goto(INDEX);
    await expect(page).toHaveTitle(/openroles/i);
    await expect(page.locator("h1")).toBeVisible();
    await expect(page.locator(".manifest")).toBeVisible();
  });

  test("has no critical or serious axe violations", async ({ page }) => {
    await page.goto(INDEX);
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    const blocking = results.violations.filter(
      (v) => v.impact === "critical" || v.impact === "serious",
    );
    expect(blocking, JSON.stringify(blocking, null, 2)).toEqual([]);
  });

  test("filter table island hydrates and event handlers update the URL", async ({ page }) => {
    await page.goto(INDEX);
    // SSR renders the chip <input> elements; only after hydration does clicking
    // a chip fire toggleAts → syncUrl(state) → history.replaceState. Asserting
    // on the URL change proves the island actually hydrated, not just that the
    // SSR template rendered. (The earlier version of this test asserted on
    // `getByRole("status")` and a sort <select> — both are present in the SSR
    // shell and would pass even if hydration crashed entirely.)
    //
    // The island is `client:idle`, so hydration happens after the page idles.
    // We poll the click until the URL reflects the toggle: if Playwright clicks
    // before the onchange handler is wired, the click is a no-op and we retry.
    await expect(async () => {
      await page.getByRole("checkbox", { name: "greenhouse" }).click();
      await expect(page).toHaveURL(/[?&]ats=greenhouse(\b|&|$)/, { timeout: 500 });
    }).toPass({ timeout: 5_000 });
  });
});

test.describe("RSS feed", () => {
  test("/feed.xml is reachable and serves either the RSS feed or the unbuilt placeholder", async ({
    request,
  }) => {
    const res = await request.get(FEED);
    expect(res.status()).toBeLessThan(500);
    expect(res.headers()["content-type"] ?? "").toMatch(/xml/i);
    const body = await res.text();
    // Astro pre-renders feed.xml at build time. Whatever body the route handler
    // returned for the unbuilt case is frozen into a static file (and served
    // with content-type: text/xml because of the extension). The body content
    // is the discriminator — either the RSS doc or the plaintext placeholder.
    const isRss = body.includes("<rss") && body.includes("<?xml");
    const isPlaceholder = body.includes("data not built");
    expect(
      isRss || isPlaceholder,
      `feed.xml body unrecognized; first 120 chars: ${body.slice(0, 120)}`,
    ).toBe(true);
  });
});
