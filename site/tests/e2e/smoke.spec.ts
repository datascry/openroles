import AxeBuilder from "@axe-core/playwright";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { SITE_BASE } from "../../playwright.config.ts";

const INDEX = `${SITE_BASE}/`;

/**
 * The uplift v2 filter chrome (specs/uplift-v2-handoff.md §2) renders the
 * filter groups in a persistent sidebar at viewports ≥ 800 px and behind a
 * "Filters" sheet button below that breakpoint. Both surfaces render the
 * same chip components in the DOM at the same time — `display: none` hides
 * the sidebar on narrow viewports, but Playwright's `.first()` selector
 * doesn't consider visibility, so we always have to scope chip queries to
 * the surface that's actually visible. This helper opens the sheet on
 * mobile and returns a Locator scoped to the active surface.
 */
async function openFilterUi(page: Page): Promise<Locator> {
  const sheetBtn = page.getByRole("button", { name: /^Filters(\s|·|$)/ });
  if (await sheetBtn.isVisible().catch(() => false)) {
    await sheetBtn.click();
    const dialog = page.getByRole("dialog", { name: /^Filters$/i });
    await expect(dialog).toBeVisible();
    // The sheet uses a 180ms slide-up CSS transform; chip clicks during the
    // transition can land off-target because Playwright's actionability
    // check sees the moving element. Wait for the transition to settle.
    await page.waitForFunction(
      () => {
        const el = document.querySelector(".sheet");
        if (!el) return false;
        const t = getComputedStyle(el).transform;
        return t === "matrix(1, 0, 0, 1, 0, 0)" || t === "none";
      },
      undefined,
      { timeout: 2_000 },
    );
    // ATS group inside the sheet should be reachable.
    await expect(dialog.getByRole("button", { name: /^greenhouse(\b|,)/i })).toBeVisible({
      timeout: 5_000,
    });
    return dialog;
  }
  // Desktop sidebar — labelled <aside aria-label="Filters">. Use the
  // <complementary role + accessible name to scope.
  const sidebar = page.getByRole("complementary", { name: /^Filters$/i });
  await expect(sidebar.getByRole("button", { name: /^greenhouse(\b|,)/i })).toBeVisible({
    timeout: 5_000,
  });
  return sidebar;
}

test.describe("index page smoke", () => {
  test("renders the page chrome and a status line", async ({ page }) => {
    await page.goto(INDEX);
    await expect(page).toHaveTitle(/openroles/i);
    // h2 lede heading is what the brutalist theme renders inside <main>; the
    // page-level <h1>-equivalent is the masthead brand mark.
    await expect(page.locator("header.masthead .brand")).toBeVisible();
    // Phase 11 dropped the in-page .manifest line; the role count lives in
    // the SEO title and the masthead strap. Assert one of those.
    await expect(page.locator("header.masthead .strap")).toContainText(/LIVE/);
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
    // Open the relevant filter surface (sidebar on desktop, sheet on mobile)
    // and toggle the greenhouse chip. The chip is implemented as an
    // aria-pressed button rather than a checkbox so query by role=button.
    await expect(async () => {
      const surface = await openFilterUi(page);
      await surface.getByRole("button", { name: /^greenhouse(\b|,)/i }).click();
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
    // Phase 11 dropped the per-row ATS label; assert on the company name
    // instead (Stripe / Linear / Vercel are the headline fixture jobs).
    await expect(
      results.locator(".company-name").filter({ hasText: "Linear" }).first(),
    ).toBeVisible({
      timeout: 15_000,
    });
    const surface = await openFilterUi(page);
    await surface.getByRole("button", { name: /^greenhouse(\b|,)/i }).click();
    // Greenhouse-only filter: Linear (lever) and any Ashby companies drop.
    await expect(results.locator(".company-name").filter({ hasText: "Linear" })).toHaveCount(0, {
      timeout: 5_000,
    });
    await expect(
      results.locator(".company-name").filter({ hasText: "Stripe" }).first(),
    ).toBeVisible();
  });

  test("pager renders when total exceeds page size and prev/next navigates pages", async ({
    page,
  }) => {
    // Default since="all" already includes every fixture row, so no extra
    // URL param needed for the 56-row corpus to drive pagination.
    await page.goto(INDEX);
    const results = page.getByTestId("job-results");
    await expect(results).toBeVisible({ timeout: 15_000 });
    const pager = page.getByTestId("pager");
    await expect(pager).toBeVisible({ timeout: 15_000 });
    // Numbered pager: page 1 is the current button, marked aria-current="page".
    await expect(pager.locator(".pager-page.is-current")).toHaveText("1");
    // Prev is disabled on page 1.
    await expect(pager.getByRole("button", { name: "Previous page" })).toBeDisabled();
    // Click next; page indicator updates and URL reflects ?page=2.
    await pager.getByRole("button", { name: "Next page" }).click();
    await expect(pager.locator(".pager-page.is-current")).toHaveText("2");
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

  test("renders STALE badge on carried-forward rows and Verified-only filter excludes them", async ({
    page,
  }) => {
    await page.goto(INDEX);
    const results = page.getByTestId("job-results");
    await expect(results).toBeVisible({ timeout: 15_000 });
    // Fixture flags one Linear row as is_stale=1 (see build-fixture-db.ts).
    // The badge is muted-ink mono caps "STALE". The previous "STALE · ND"
    // form encoded days-since-last-seen, but last_seen_at is no longer
    // shipped to the slim-index (kept in role-detail SQLite for payload
    // budget); without it the day count would be guesswork. Assert just
    // the marker.
    const staleBadge = page.locator(".stale-badge").first();
    await expect(staleBadge).toBeVisible({ timeout: 15_000 });
    await expect(staleBadge).toHaveText("STALE");

    // The whole row should dim. Assert opacity=0.6 on the parent .job.
    const staleRow = page.locator("li.job.is-stale").first();
    await expect(staleRow).toBeVisible();
    const opacity = await staleRow.evaluate((el) => getComputedStyle(el).opacity);
    expect(Number.parseFloat(opacity)).toBeLessThanOrEqual(0.61);

    // Toggle "Verified only" — the stale row should disappear. The switch
    // lives in the Status group inside the sidebar / sheet (uplift v2 §2.6).
    const surface = await openFilterUi(page);
    await surface.getByRole("switch", { name: /verified only/i }).click();
    await expect(page.locator("li.job.is-stale")).toHaveCount(0, { timeout: 5_000 });
    // URL reflects the filter.
    await expect(page).toHaveURL(/[?&]hide_stale=1(\b|&|$)/);
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

test.describe("RSS feed (removed)", () => {
  test("/feed.xml is no longer deployed", async ({ request }) => {
    const res = await request.get(`${SITE_BASE}/feed.xml`);
    // RSS was removed: GitHub Pages returns 404 for the path; readers
    // that still subscribed to the feed see a 404 and stop polling.
    expect(res.status()).toBe(404);
  });
});
