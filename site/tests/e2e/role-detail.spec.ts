import AxeBuilder from "@axe-core/playwright";
import { jobId } from "@openroles/shared";
import { expect, test } from "@playwright/test";
import { SITE_BASE } from "../../playwright.config.ts";

// Mirrors the fixture jobs in scripts/build-fixture-db.ts. The id is the
// SHA-256 of (ats, tenant_slug, source_id, url) — stable across test runs
// as long as the fixture inputs don't change.
const STRIPE_PAYMENTS_JOB = {
  ats: "greenhouse" as const,
  tenant_slug: "stripe",
  source_id: "stripe-1",
  url: "https://boards.greenhouse.io/stripe/jobs/1",
};
const stripeShortId = jobId(STRIPE_PAYMENTS_JOB).slice(0, 16);
const STRIPE_URL = `${SITE_BASE}/role/?id=${stripeShortId}`;

const NOT_FOUND_URL = `${SITE_BASE}/role/?id=0000000000000000`;
const THEMED_404_URL = `${SITE_BASE}/this-page-does-not-exist`;

test.describe("role detail page (client-rendered)", () => {
  test("renders the role title, company, description, and apply CTA after client load", async ({
    page,
  }) => {
    await page.goto(STRIPE_URL);
    await expect(page.locator("h1")).toContainText("Senior Software Engineer, Payments", {
      timeout: 15_000,
    });
    await expect(page.locator(".company")).toContainText("Stripe");
    await expect(page.locator(".role-body p")).toContainText(/Excerpt for/i);
    const apply = page.getByRole("link", { name: /Apply on Greenhouse/i });
    await expect(apply).toHaveAttribute("href", STRIPE_PAYMENTS_JOB.url);
    await expect(apply).toHaveAttribute("target", "_blank");
    await expect(apply).toHaveAttribute("rel", /noopener/);
  });

  test("sets the document title from the loaded role for share-link unfurls", async ({ page }) => {
    await page.goto(STRIPE_URL);
    await expect(page).toHaveTitle(/Senior Software Engineer.*Stripe/i, { timeout: 15_000 });
  });

  test("emits a noindex meta tag (per-role pages are not crawlable)", async ({ page }) => {
    await page.goto(STRIPE_URL);
    const robots = await page.locator('meta[name="robots"]').getAttribute("content");
    expect(robots).toMatch(/noindex/);
  });

  test("Save button toggles localStorage state", async ({ page }) => {
    await page.goto(STRIPE_URL);
    const fullId = jobId(STRIPE_PAYMENTS_JOB);
    const save = page.locator(".role-actions button").first();
    await expect(save).toBeVisible({ timeout: 15_000 });
    await expect(save).toHaveAttribute("aria-pressed", "false");
    await save.click();
    await expect(save).toHaveAttribute("aria-pressed", "true");
    const persisted = await page.evaluate(
      (key) => globalThis.localStorage.getItem(key),
      "openroles:v1:saved",
    );
    const parsed = JSON.parse(persisted ?? "{}") as { version: number; ids: string[] };
    expect(parsed.ids).toContain(fullId);
  });

  test("shows an explanatory message when the short id resolves to no row", async ({ page }) => {
    await page.goto(NOT_FOUND_URL);
    await expect(page.locator(".role-error")).toContainText(/isn't in the current database/i, {
      timeout: 15_000,
    });
    await expect(page.getByRole("link", { name: /Back to all roles/i })).toBeVisible();
  });

  test("themed 404 fires for any unknown path outside /role/", async ({ page }) => {
    const res = await page.goto(THEMED_404_URL);
    expect(res?.status()).toBe(404);
    await expect(page.locator(".not-found .status")).toHaveText("404");
  });

  test("a11y: role page passes axe-core (WCAG 2.1 AA)", async ({ page }) => {
    await page.goto(STRIPE_URL);
    // Wait for hydration; axe should run against fully-rendered content.
    await expect(page.locator("h1")).toBeVisible({ timeout: 15_000 });
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    expect(results.violations).toEqual([]);
  });

  test("a11y: 404 page passes axe-core", async ({ page }) => {
    await page.goto(THEMED_404_URL);
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    expect(results.violations).toEqual([]);
  });
});
