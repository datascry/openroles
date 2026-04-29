import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { SITE_BASE } from "../../playwright.config.ts";

const INDEX = `${SITE_BASE}/`;
const WIREFRAME = `${SITE_BASE}/wireframe`;

// WCAG 2.1 §1.4.3 relative-luminance + contrast formulas. Used to assert the
// palette clears AA without hardcoding the hex values (tokens.css owns those).
function relativeLuminance(hex: string): number {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) throw new Error(`relativeLuminance: not a 6-digit hex: ${hex}`);
  const [, r, g, b] = m as RegExpExecArray & [string, string, string, string];
  const channels = [r, g, b].map((h) => {
    const v = Number.parseInt(h, 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

test.describe("Brutalist Press chrome", () => {
  test("renders the masthead brand and strap", async ({ page }) => {
    await page.goto(INDEX);
    await expect(page).toHaveTitle(/openroles/i);
    const masthead = page.locator("header.masthead");
    await expect(masthead).toBeVisible();
    await expect(masthead.locator(".brand")).toContainText(/OPEN.*ROLES/);
    await expect(masthead.locator(".strap")).toContainText(/UPDATED/);
    await expect(masthead.locator(".strap")).toContainText(/LIVE/);
  });

  test("theme-color meta mirrors --color-paper", async ({ page }) => {
    await page.goto(INDEX);
    // Read both values from runtime CSS / DOM and compare. Hardcoding the
    // hex would re-introduce the literal that visual-theme.md §Rejection
    // cases forbids outside tokens.css and the BaseLayout meta tag itself.
    const themeColor = await page.locator('meta[name="theme-color"]').getAttribute("content");
    const cssPaper = await page.evaluate(() =>
      getComputedStyle(document.documentElement)
        .getPropertyValue("--color-paper")
        .trim()
        .toLowerCase(),
    );
    expect(themeColor?.toLowerCase()).toBe(cssPaper);
    // Sanity: the value must be a 6-digit hex (the meta tag spec requires
    // a CSS color, and our token table commits to hex literals only).
    expect(cssPaper).toMatch(/^#[0-9a-f]{6}$/);
  });

  test("--color-accent is set, hex-shaped, and clears WCAG 2.1 AA on paper", async ({ page }) => {
    await page.goto(INDEX);
    const { paper, accent } = await page.evaluate(() => {
      const styles = getComputedStyle(document.documentElement);
      return {
        paper: styles.getPropertyValue("--color-paper").trim().toLowerCase(),
        accent: styles.getPropertyValue("--color-accent").trim().toLowerCase(),
      };
    });
    expect(accent).toMatch(/^#[0-9a-f]{6}$/);
    expect(paper).toMatch(/^#[0-9a-f]{6}$/);
    // Compute WCAG relative luminance for both colors and verify the
    // contrast ratio clears the AA threshold for normal text (4.5:1).
    const ratio = contrastRatio(accent, paper);
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });

  test("the active nav item carries aria-current=page", async ({ page }) => {
    await page.goto(INDEX);
    const active = page.locator("header.masthead nav a[aria-current='page']");
    await expect(active).toHaveCount(1);
    await expect(active).toContainText(/BROWSE/);
  });

  test("interactive elements meet the 44 px tap-target floor", async ({ page }) => {
    await page.goto(INDEX);
    // Limit the audit to the page chrome (masthead + footer). The FilterTable
    // island carries Phase 8's separate accessibility coverage in smoke.spec.
    const targets = await page
      .locator("header.masthead a, header.masthead button, footer a")
      .evaluateAll((nodes) =>
        nodes.map((n) => {
          const r = (n as HTMLElement).getBoundingClientRect();
          return { tag: n.tagName, w: r.width, h: r.height };
        }),
      );
    const small = targets.filter((t) => t.w < 44 || t.h < 44);
    expect(small, JSON.stringify(small)).toEqual([]);
  });

  test("zero axe-core WCAG 2.1 AA violations on desktop", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(WIREFRAME);
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    const blocking = results.violations.filter(
      (v) => v.impact === "critical" || v.impact === "serious",
    );
    expect(blocking, JSON.stringify(blocking, null, 2)).toEqual([]);
  });

  test("zero axe-core WCAG 2.1 AA violations on mobile", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(WIREFRAME);
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
      .analyze();
    const blocking = results.violations.filter(
      (v) => v.impact === "critical" || v.impact === "serious",
    );
    expect(blocking, JSON.stringify(blocking, null, 2)).toEqual([]);
  });
});
