/**
 * End-to-end coverage for the Uplift v2 surfaces (specs/uplift-v2-handoff.md):
 *   1. Dual-mode tabbed search bar
 *   2. Persistent sidebar (desktop) + sheet (mobile) with chip counts
 *   3. Editorial broadsheet role-detail
 *
 * Per CLAUDE.md the project's per-file 95/95/90 coverage floor applies to
 * `.ts` files. `.svelte` components are exercised here against the real
 * rendered page so behavioural regressions on the new surfaces are caught
 * by `bun run e2e` even though `bun test` doesn't instrument the templates.
 */

import { jobId } from "@openroles/shared";
import { expect, test } from "@playwright/test";
import { SITE_BASE } from "../../playwright.config.ts";

const INDEX = `${SITE_BASE}/`;

test.describe("PR C — dual-mode tabbed search", () => {
  test("renders both tabs with WAI-ARIA Tabs semantics", async ({ page }) => {
    await page.goto(INDEX);
    const tablist = page.getByRole("tablist", { name: /search mode/i });
    await expect(tablist).toBeVisible();
    const free = tablist.getByRole("tab", { name: /free text/i });
    const structured = tablist.getByRole("tab", { name: /structured/i });
    await expect(free).toHaveAttribute("aria-selected", "true");
    await expect(structured).toHaveAttribute("aria-selected", "false");
  });

  test("ArrowRight on the active tab switches to the next tab", async ({ page }) => {
    await page.goto(INDEX);
    // Wait for SearchBar hydration so the keydown handler is attached.
    await expect(page.getByRole("tab", { name: /free text/i })).toBeVisible();
    await page.waitForFunction(
      () => Boolean(document.querySelector(".searchbar [role='tablist']")),
      undefined,
      { timeout: 15_000 },
    );
    const free = page.getByRole("tab", { name: /free text/i });
    await free.focus();
    await page.keyboard.press("ArrowRight");
    const structured = page.getByRole("tab", { name: /structured/i });
    await expect(structured).toHaveAttribute("aria-selected", "true", { timeout: 5_000 });
  });

  test('structured submit composes title:"engineer" into the URL', async ({ page }) => {
    await page.goto(INDEX);
    // Wait for SearchBar to hydrate so the tab click attaches a real handler.
    await page.waitForFunction(
      () => Boolean(document.querySelector(".searchbar [role='tablist']")),
      undefined,
      { timeout: 15_000 },
    );
    await page.getByRole("tab", { name: /structured/i }).click();
    const titleInput = page.locator(".field input").first();
    await expect(titleInput).toBeVisible();
    await titleInput.fill("engineer");
    await page.getByRole("button", { name: /^search$/i }).click();
    await expect(page).toHaveURL(/q=title%3A%22engineer%22/, { timeout: 5_000 });
  });

  test("typing in free text fires onChange after the debounce", async ({ page }) => {
    await page.goto(INDEX);
    // Wait for the SearchBar to hydrate before typing — otherwise the fill
    // happens before Svelte attaches the oninput handler.
    const input = page.locator(".free-label input");
    await expect(input).toBeVisible();
    await page.waitForFunction(
      () => Boolean(document.querySelector(".searchbar [role='tablist']")),
      undefined,
      { timeout: 15_000 },
    );
    await input.fill("designer");
    // 250 ms debounce + a small slop for the URL replaceState call.
    await expect(page).toHaveURL(/q=designer/, { timeout: 5_000 });
  });

  test("structured tab is selected on first paint when q is purely structured", async ({
    page,
  }) => {
    await page.goto(`${INDEX}?q=title%3A%22engineer%22`);
    await expect(page.getByRole("tab", { name: /structured/i })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  test("structured-mode footer surfaces remaining free-text on a mixed query", async ({ page }) => {
    await page.goto(`${INDEX}?q=title%3A%22engineer%22%20staff%20at`);
    // Page paints in free-text mode for a mixed query; switch to Structured.
    await page.getByRole("tab", { name: /structured/i }).click();
    await expect(page.locator(".structured-footer")).toContainText(/staff at/i);
  });

  test("save current opens an inline label prompt", async ({ page }) => {
    await page.goto(`${INDEX}?q=title%3A%22engineer%22`);
    const save = page.getByRole("button", { name: /save current/i });
    await expect(save).not.toBeDisabled();
    await save.click();
    await expect(page.locator("input#save-prompt-input")).toBeVisible();
  });

  test("save trigger is disabled when q is empty", async ({ page }) => {
    await page.goto(INDEX);
    const save = page.getByRole("button", { name: /save current/i });
    // Hidden when no saved searches AND no q (spec §1.7.f).
    await expect(save).toHaveCount(0);
  });
});

test.describe("PR B — sidebar (desktop) + chip counts", () => {
  test.use({ viewport: { width: 1200, height: 900 } });

  test("renders the persistent sidebar at >=800 px", async ({ page }) => {
    await page.goto(INDEX);
    await expect(page.locator("aside.sidebar")).toBeVisible();
    // The mobile-only "Filters" sheet button collapses to display:none
    // above 800 px (specs/uplift-v2-handoff.md §2). The button is still in
    // the DOM but should be hidden — toBeVisible() returns false.
    await expect(page.locator(".filters-button")).toBeHidden();
  });

  test("ATS chips show per-option counts and disable zero-match rows", async ({ page }) => {
    await page.goto(INDEX);
    // Wait for option counts to populate (the per-dimension queries fire
    // alongside the main results query).
    await page.waitForFunction(
      () => document.querySelectorAll(".sidebar .chip-count").length > 0,
      undefined,
      { timeout: 10_000 },
    );
    const greenhouseChip = page.locator(".sidebar .chip", { hasText: /greenhouse/i });
    await expect(greenhouseChip.locator(".chip-count")).toBeVisible();
    // bamboohr has zero matches in the fixture corpus.
    const bamboo = page.locator(".sidebar .chip", { hasText: /bamboohr/i });
    await expect(bamboo).toBeDisabled();
  });

  test("clicking an active chip toggles it back off", async ({ page }) => {
    await page.goto(INDEX);
    // Wait for option counts to land before clicking — the chip's aria-label
    // updates from "remote" to "remote, 39 roles" once the slim-index is
    // ready, and Playwright can otherwise click during the re-render.
    await page.waitForFunction(
      () => document.querySelectorAll("aside.sidebar .chip-count").length > 0,
      undefined,
      { timeout: 10_000 },
    );
    const remoteChip = page
      .locator("aside.sidebar")
      .getByRole("button", { name: /^remote(\b|,)/i });
    await remoteChip.click();
    await expect(remoteChip).toHaveAttribute("aria-pressed", "true");
    await expect(page).toHaveURL(/wt=remote/);
    await remoteChip.click();
    await expect(remoteChip).toHaveAttribute("aria-pressed", "false");
  });

  test("Reset all is disabled when no filters are active", async ({ page }) => {
    // The runtime default is `since: "all"` (matches the masthead total)
    // and every other group is empty on a fresh visit; activeCount=0.
    await page.goto(INDEX);
    await expect(page.locator("aside.sidebar .reset-all")).toBeDisabled();
  });

  test("active count surfaces in the sidebar header", async ({ page }) => {
    // Visit with the runtime default since so only the explicit ats filter
    // counts as active (since !== default-since would also tick the count;
    // see filter-active-count.ts).
    await page.goto(`${INDEX}?ats=greenhouse`);
    await expect(page.locator("aside.sidebar .active-pill")).toContainText(/1 active/i);
  });
});

test.describe("PR B — mobile sheet", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test("renders the mobile bar at <800 px (sidebar hidden)", async ({ page }) => {
    await page.goto(INDEX);
    // The mobile filter affordance is the .filters-button inside the
    // existing .filter-bar — no separate .mobile-bar surface in the
    // upstream-integrated wiring.
    await expect(page.locator(".filters-button")).toBeVisible();
    // The sidebar's parent .sidebar-col is display:none on mobile, so the
    // FilterSidebar component's `aside.sidebar` is hidden too.
    await expect(page.locator("aside.sidebar")).toBeHidden();
  });

  test("FILTERS button opens the sheet, Close hides it", async ({ page }) => {
    await page.goto(INDEX);
    const overlay = page.locator(".overlay");
    // Wait for the FilterTable island to hydrate before opening.
    await page.waitForFunction(
      () => Boolean(document.querySelector(".filters-button")),
      undefined,
      { timeout: 15_000 },
    );
    await expect(overlay).not.toHaveClass(/is-open/);
    await page.locator(".filters-button").click();
    await expect(overlay).toHaveClass(/is-open/);
    // Apply button preview reads "Show N roles" after the slim-index query
    // resolves; allow up to 10 s for the in-memory filter to settle.
    const apply = page.locator(".sheet-foot .apply");
    await expect(apply).toContainText(/show \d+ roles/i, { timeout: 10_000 });
    await page.locator(".close-btn").click();
    await expect(overlay).not.toHaveClass(/is-open/);
  });

  test("Esc closes the sheet", async ({ page }) => {
    await page.goto(INDEX);
    // Wait for FilterTable hydration before clicking; the click handler
    // attaches as part of Svelte's mount and a pre-hydration click is
    // a no-op (the static SSR markup has no listener).
    await page.waitForFunction(
      () => Boolean(document.querySelector(".filters-button")),
      undefined,
      { timeout: 15_000 },
    );
    await page.locator(".filters-button").click();
    await expect(page.locator(".overlay")).toHaveClass(/is-open/);
    await page.keyboard.press("Escape");
    await expect(page.locator(".overlay")).not.toHaveClass(/is-open/);
  });
});

const STRIPE_PAYMENTS_JOB = {
  ats: "greenhouse" as const,
  tenant_slug: "stripe",
  source_id: "stripe-1",
  url: "https://boards.greenhouse.io/stripe/jobs/1",
};
const stripeShortId = jobId(STRIPE_PAYMENTS_JOB).slice(0, 16);
const ROLE_URL = `${SITE_BASE}/role/?id=${stripeShortId}`;

test.describe("PR D — editorial role detail", () => {
  test("renders the editorial frame: kicker, headline, strap, byline, body, fact card", async ({
    page,
  }) => {
    await page.goto(ROLE_URL);
    await expect(page.locator(".kicker")).toContainText(/stripe/i);
    await expect(page.locator(".headline")).toBeVisible();
    await expect(page.locator(".byline")).toBeVisible();
    await expect(page.locator(".byline")).toHaveAttribute("aria-label", /role facts/i);
    await expect(page.locator(".fact-card .fact-h")).toContainText(/the facts/i);
    // Apply CTA in the desktop right rail.
    const apply = page.getByRole("link", { name: /apply for .* on Greenhouse/i });
    await expect(apply.first()).toHaveAttribute("target", "_blank");
  });

  test("byline is a real list with per-fact <li> items (a11y per spec §3.9)", async ({ page }) => {
    await page.goto(ROLE_URL);
    const items = page.locator(".byline > .byline-item");
    await expect(items.first()).toBeVisible();
    expect(await items.count()).toBeGreaterThanOrEqual(1);
  });

  test("local-state disclosure paragraph renders below the body", async ({ page }) => {
    await page.goto(ROLE_URL);
    await expect(page.locator(".local-state-disclosure")).toContainText(
      /stored in this browser only/i,
    );
  });

  test("rail-top freshness tag uses one of the spec'd tones", async ({ page }) => {
    await page.goto(ROLE_URL);
    const tag = page.locator(".fresh-tag");
    await expect(tag).toBeVisible();
    const cls = await tag.getAttribute("class");
    expect(cls).toMatch(/fresh-tag--(fresh|active|muted)/);
  });

  test("Save button toggles aria-pressed and writes localStorage", async ({ page }) => {
    await page.goto(ROLE_URL);
    // Either inflow (mobile) or rail (desktop) card is visible; pick whichever
    // the current viewport rendered.
    const save = page.locator(".apply-card:visible .action").first();
    await expect(save).toBeVisible();
    await expect(save).toHaveAttribute("aria-pressed", "false");
    await save.click();
    await expect(save).toHaveAttribute("aria-pressed", "true");
    const persisted = await page.evaluate(() =>
      globalThis.localStorage.getItem("openroles:v1:saved"),
    );
    expect(persisted).toContain("ids");
  });

  test("not-found id renders the themed error inside the editorial frame", async ({ page }) => {
    await page.goto(`${SITE_BASE}/role/?id=0000000000000000`);
    await expect(page.locator(".role-error .headline")).toContainText(/role not found/i);
    await expect(page.getByRole("link", { name: /back to all roles/i })).toBeVisible();
  });
});

test.describe("PR D — editorial role detail (mobile)", () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test("in-flow apply card renders inside the body on mobile", async ({ page }) => {
    await page.goto(ROLE_URL);
    const inflow = page.locator(".apply-card--inflow");
    await expect(inflow).toBeVisible();
    await expect(inflow).toHaveAttribute("aria-hidden", "false");
  });

  test("sticky-apply DOM is mounted (CSS controls visibility)", async ({ page }) => {
    await page.goto(ROLE_URL);
    // Always mounted; visibility is class-driven so the slide animation
    // can play. Without scroll the bar stays translateY(100%).
    await expect(page.locator(".sticky-apply")).toHaveCount(1);
  });
});
