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

  test("filter table island hydrates with interactive controls", async ({ page }) => {
    await page.goto(INDEX);
    // Hydration is deferred to client:idle; wait for the loading status to appear,
    // then for the interactive sort control rendered by the Svelte island.
    await expect(page.getByRole("status").getByText(/loading data/i)).toBeVisible();
    await expect(page.getByRole("combobox", { name: /sort/i })).toBeVisible();
  });
});

test.describe("RSS feed", () => {
  test("/feed.xml is reachable and serves either the RSS feed or the unbuilt placeholder", async ({
    request,
  }) => {
    const res = await request.get(FEED);
    expect(res.status()).toBeLessThan(500);
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
