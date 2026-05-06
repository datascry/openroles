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
async function expandAtsGroup(scope: Locator): Promise<void> {
  // ATS now defaults collapsed across both desktop sidebar and mobile
  // sheet (FilterGroups expansion default). The first thing tests need
  // to do before reaching the chips is click the ATS group header to
  // open it. Idempotent: if it's already expanded, the click toggles
  // it shut and we'd miss the chip — so guard on aria-expanded first.
  const header = scope.getByRole("button", { name: /^ATS(\b|·|,)/i });
  await expect(header).toBeVisible({ timeout: 5_000 });
  const expanded = (await header.getAttribute("aria-expanded")) === "true";
  if (!expanded) await header.click();
}

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
    await expandAtsGroup(dialog);
    await expect(dialog.getByRole("button", { name: /^greenhouse(\b|,)/i })).toBeVisible({
      timeout: 5_000,
    });
    return dialog;
  }
  // Desktop sidebar — labelled <aside aria-label="Filters">. Use the
  // <complementary role + accessible name to scope.
  const sidebar = page.getByRole("complementary", { name: /^Filters$/i });
  await expandAtsGroup(sidebar);
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
    // The Save button is glyph-only (☆/★). aria-label flips between
    // "Save this role" and "Remove from saved" on click, so a name-
    // regex locator is invalidated by its own click. Use the stable
    // .job-action.save class instead — that survives state changes.
    const saveBtn = stripeRow.locator(".job-action.save");
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
    await expect(reloadedRow.locator(".job-action.save")).toHaveAttribute("aria-pressed", "true", {
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

    // Stale row reads as muted via per-child colour overrides rather
    // than parent opacity. The previous test asserted opacity ≤ 0.61
    // but axe (correctly) flagged that as a contrast failure since
    // opacity desaturates every descendant text colour. The current
    // visual rule: the row carries the .is-stale class, the title
    // drops from --color-ink to --color-ink-2, and the company name
    // drops from --color-accent to --color-ink-3. Assert the row's
    // class is present and the company-name is no longer accent red.
    const staleRow = page.locator("li.job.is-stale").first();
    await expect(staleRow).toBeVisible();
    const companyColor = await staleRow
      .locator(".company-name")
      .first()
      .evaluate((el) => getComputedStyle(el).color);
    // --color-ink-3 in light mode is rgb(110, 106, 99); --color-accent
    // is rgb(200, 38, 26). Assert it's the muted ink-3, not accent.
    expect(companyColor).toMatch(/rgb\(110, 106, 99\)/);

    // Toggle "Verified only" — the stale row should disappear. The switch
    // lives in the Status group inside the sidebar / sheet (uplift v2 §2.6).
    // Status defaults to collapsed (ADR-0014); expand it before clicking
    // through.
    const surface = await openFilterUi(page);
    const statusHeader = surface.getByRole("button", { name: /^Status(\b|·|,)/i });
    if ((await statusHeader.getAttribute("aria-expanded")) === "false") {
      await statusHeader.click();
    }
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
    // Ignore button is glyph-only (×/↺); accessible name comes from
    // aria-label "Hide this role" / "Restore this role".
    await linearRow.getByRole("button", { name: /Hide this role/i }).click();
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
