import { defineConfig, devices } from "@playwright/test";

const PREVIEW_PORT = 4321;
const HOST_URL = `http://127.0.0.1:${PREVIEW_PORT}`;
// Astro serves under base="/openroles"; baseURL only sets the host so test paths
// can stay literal (`/openroles/feed.xml`). URL resolution drops the base path
// when paths are root-relative, which is why we don't include it here.
export const SITE_BASE = "/openroles";
// Chrome DevTools Protocol port for the lighthouse project. Lighthouse
// connects over CDP to the browser Playwright launches; the port must match
// what the Chromium binary is started with.
export const LIGHTHOUSE_CDP_PORT = 9222;

export default defineConfig({
  testDir: "./tests/e2e",
  globalSetup: "./tests/e2e/global-setup.ts",
  fullyParallel: true,
  forbidOnly: !!process.env["CI"],
  retries: process.env["CI"] ? 2 : 0,
  workers: process.env["CI"] ? 1 : undefined,
  reporter: process.env["CI"] ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: HOST_URL,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      testIgnore: /lighthouse\.spec\.ts$/,
    },
    {
      name: "mobile-chrome",
      use: { ...devices["Pixel 7"] },
      testIgnore: /lighthouse\.spec\.ts$/,
    },
    {
      // Lighthouse needs Chromium launched with --remote-debugging-port so it
      // can connect over the DevTools Protocol. Runs only the lighthouse
      // spec; everything else uses the standard projects above.
      name: "lighthouse",
      testMatch: /lighthouse\.spec\.ts$/,
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: { args: [`--remote-debugging-port=${LIGHTHOUSE_CDP_PORT}`] },
      },
    },
  ],
  webServer: {
    command: `bun --bun astro preview --host 127.0.0.1 --port ${PREVIEW_PORT}`,
    url: `${HOST_URL}${SITE_BASE}`,
    reuseExistingServer: !process.env["CI"],
    timeout: 120_000,
  },
});
