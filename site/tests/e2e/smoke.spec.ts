import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

test.describe("index page smoke", () => {
  test("renders the page chrome and a status line", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveTitle(/openroles/i);
    await expect(page.locator("h1")).toBeVisible();
    await expect(page.locator(".manifest")).toBeVisible();
  });

  test("has no critical or serious axe violations", async ({ page }) => {
    await page.goto("/");
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    const blocking = results.violations.filter(
      (v) => v.impact === "critical" || v.impact === "serious",
    );
    expect(blocking, JSON.stringify(blocking, null, 2)).toEqual([]);
  });

  test("filter table island hydrates with interactive controls", async ({ page }) => {
    await page.goto("/");
    // Hydration is deferred to client:idle; wait for the loading status to appear,
    // then for the interactive sort control rendered by the Svelte island.
    await expect(page.getByRole("status").getByText(/loading data/i)).toBeVisible();
    await expect(page.getByRole("combobox", { name: /sort/i })).toBeVisible();
  });
});

test.describe("RSS feed", () => {
  test("/feed.xml returns RSS 2.0 with correct content type", async ({ request }) => {
    const res = await request.get("/feed.xml");
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toMatch(/(application|text)\/(rss\+)?xml/);
    const body = await res.text();
    expect(body).toContain('<?xml version="1.0"');
    expect(body).toContain("<rss");
  });
});
