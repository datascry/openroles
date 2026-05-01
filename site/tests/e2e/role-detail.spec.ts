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
const STRIPE_URL = `${SITE_BASE}/role/${stripeShortId}/`;

const NOT_FOUND_URL = `${SITE_BASE}/role/0000000000000000/`;
const THEMED_404_URL = `${SITE_BASE}/this-page-does-not-exist`;

test.describe("role detail page (static)", () => {
  test("renders the role title, company, description, and apply CTA", async ({ page }) => {
    await page.goto(STRIPE_URL);
    await expect(page).toHaveTitle(/Senior Software Engineer.*Stripe/i);
    await expect(page.locator("h1")).toContainText("Senior Software Engineer, Payments");
    await expect(page.locator(".company")).toContainText("Stripe");
    await expect(page.locator(".role-body p")).toContainText(/Excerpt for/i);
    const apply = page.getByRole("link", { name: /Apply on Greenhouse/i });
    await expect(apply).toHaveAttribute("href", STRIPE_PAYMENTS_JOB.url);
    await expect(apply).toHaveAttribute("target", "_blank");
    await expect(apply).toHaveAttribute("rel", /noopener/);
  });

  test("emits a JobPosting JSON-LD block in the static HTML", async ({ page }) => {
    await page.goto(STRIPE_URL);
    // <script> tags are not "visible" in Playwright's actionability sense, so
    // skip the locator's auto-wait and query the DOM directly.
    const ldText = await page.evaluate(() => {
      const scripts = Array.from(document.querySelectorAll('script[type="application/ld+json"]'));
      return scripts.map((s) => s.textContent ?? "").find((t) => t.includes('"JobPosting"'));
    });
    expect(ldText).toBeTruthy();
    const parsed = JSON.parse(ldText ?? "{}") as Record<string, unknown>;
    expect(parsed["@type"]).toBe("JobPosting");
    expect(parsed["title"]).toBe("Senior Software Engineer, Payments");
    expect((parsed["hiringOrganization"] as { name?: string })?.name).toBe("Stripe");
    expect(parsed["url"]).toBe(STRIPE_PAYMENTS_JOB.url);
    // The fixture marks this role as remote; assert the TELECOMMUTE marker.
    expect(parsed["jobLocationType"]).toBe("TELECOMMUTE");
  });

  test("Save button toggles localStorage state", async ({ page }) => {
    await page.goto(STRIPE_URL);
    const fullId = jobId(STRIPE_PAYMENTS_JOB);
    // The Save button is the first button inside .role-actions; it's
    // labelled ☆ Save / ★ Saved depending on state. Match on its
    // aria-pressed attribute rather than its text — the unicode star
    // glyphs are unreliable for getByRole name matching across browsers.
    const save = page.locator(".role-actions button").first();
    await expect(save).toBeVisible();
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

  test("returns the themed 404 page for an unknown short id", async ({ page }) => {
    const res = await page.goto(NOT_FOUND_URL);
    expect(res?.status()).toBe(404);
    await expect(page.locator(".not-found .status")).toHaveText("404");
    await expect(page.locator(".not-found h1")).toContainText("isn't here");
    await expect(page.getByRole("link", { name: /Browse all open roles/i })).toBeVisible();
  });

  test("themed 404 fires for any unknown path", async ({ page }) => {
    const res = await page.goto(THEMED_404_URL);
    expect(res?.status()).toBe(404);
    await expect(page.locator(".not-found .status")).toHaveText("404");
  });

  test("a11y: role page passes axe-core (WCAG 2.1 AA)", async ({ page }) => {
    await page.goto(STRIPE_URL);
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
