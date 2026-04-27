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
    // SSR template rendered.
    //
    // The island is `client:idle`, so hydration happens after the page idles.
    // We poll the click until the URL reflects the toggle: if Playwright clicks
    // before the onchange handler is wired, the click is a no-op and we retry.
    await expect(async () => {
      await page.getByRole("checkbox", { name: "greenhouse" }).click();
      await expect(page).toHaveURL(/[?&]ats=greenhouse(\b|&|$)/, { timeout: 500 });
    }).toPass({ timeout: 5_000 });
  });

  test("renders job results from the fixture database", async ({ page }) => {
    await page.goto(INDEX);
    // Fixture has 4 headline jobs (Stripe/Vercel/Linear) + 52 filler rows so
    // pagination has something to do; assert the headline rows are visible
    // rather than a fixed count, which is robust to fixture growth.
    const results = page.getByTestId("job-results");
    await expect(results).toBeVisible({ timeout: 15_000 });
    await expect(results.locator(".company", { hasText: "Stripe" }).first()).toBeVisible();
    await expect(results.locator(".company", { hasText: "Vercel" }).first()).toBeVisible();
    await expect(results.locator(".company", { hasText: "Linear" }).first()).toBeVisible();
  });

  test("clicking an ATS chip narrows the result set to that ATS only", async ({ page }) => {
    await page.goto(INDEX);
    const results = page.getByTestId("job-results");
    await expect(results).toBeVisible({ timeout: 15_000 });
    // Wait until rows render; lever/ashby are present in the unfiltered set.
    await expect(results.locator(".ats", { hasText: "lever" }).first()).toBeVisible({
      timeout: 15_000,
    });
    await page.getByRole("checkbox", { name: "greenhouse" }).click();
    // Assert the property — only greenhouse rows remain — rather than the
    // fixture cardinality, so the test survives fixture growth. (Audit m5.)
    await expect(results.locator(".ats", { hasText: "lever" })).toHaveCount(0, { timeout: 5_000 });
    await expect(results.locator(".ats", { hasText: "ashby" })).toHaveCount(0);
    await expect(results.locator(".ats", { hasText: "greenhouse" }).first()).toBeVisible();
  });

  test("pager renders when total exceeds page size and prev/next navigates pages", async ({
    page,
  }) => {
    await page.goto(INDEX);
    const results = page.getByTestId("job-results");
    await expect(results).toBeVisible({ timeout: 15_000 });
    const pager = page.getByTestId("pager");
    await expect(pager).toBeVisible({ timeout: 15_000 });
    await expect(pager.getByText(/Page 1 of/)).toBeVisible();
    // Prev is disabled on page 1.
    await expect(pager.getByRole("button", { name: "Previous page" })).toBeDisabled();
    // Click next; page indicator updates and URL reflects ?page=2.
    await pager.getByRole("button", { name: "Next page" }).click();
    await expect(pager.getByText(/Page 2 of/)).toBeVisible();
    await expect(page).toHaveURL(/[?&]page=2(\b|&|$)/);
  });

  test("save button toggles aria-pressed and persists across navigation", async ({ page }) => {
    await page.goto(INDEX);
    const results = page.getByTestId("job-results");
    await expect(results).toBeVisible({ timeout: 15_000 });
    const stripeRow = results
      .locator("li.job")
      .filter({ has: page.locator(".company", { hasText: "Stripe" }) })
      .first();
    const saveBtn = stripeRow.getByRole("button", { name: /Save/ });
    await expect(saveBtn).toHaveAttribute("aria-pressed", "false");
    await saveBtn.click();
    await expect(saveBtn).toHaveAttribute("aria-pressed", "true");
    // Reload and confirm persistence via localStorage.
    await page.reload();
    const reloadedRow = page
      .getByTestId("job-results")
      .locator("li.job")
      .filter({ has: page.locator(".company", { hasText: "Stripe" }) })
      .first();
    await expect(reloadedRow.getByRole("button", { name: /★ Saved/ })).toBeVisible({
      timeout: 15_000,
    });
  });

  test("ignore button removes the row from the visible set", async ({ page }) => {
    await page.goto(INDEX);
    const results = page.getByTestId("job-results");
    await expect(results).toBeVisible({ timeout: 15_000 });
    // Wait for Linear (the only mid-level non-filler) to render before clicking.
    const linearCompany = results.locator(".company", { hasText: "Linear" }).first();
    await expect(linearCompany).toBeVisible({ timeout: 15_000 });
    const linearRow = results
      .locator("li.job")
      .filter({ has: page.locator(".company", { hasText: "Linear" }) })
      .first();
    await linearRow.getByRole("button", { name: /^Ignore$/ }).click();
    // With "Hide ignored" on by default, the Linear row disappears.
    await expect(results.locator(".company", { hasText: "Linear" })).toHaveCount(0, {
      timeout: 5_000,
    });
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
