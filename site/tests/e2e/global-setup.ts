// Playwright globalSetup: provision the fixture SQLite + manifest and the
// sql.js-httpvfs runtime assets. Writes into both public/ (for `astro dev`
// and future builds) and dist/ (for `astro preview` against the existing
// built site, which is the path the PR workflow exercises).

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SITE_ROOT = resolve(HERE, "..", "..");

function runScript(script: string, env: NodeJS.ProcessEnv = {}): void {
  const res = spawnSync("bun", ["run", script], {
    cwd: SITE_ROOT,
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
  if (res.status !== 0) {
    throw new Error(`globalSetup: ${script} exited with status ${res.status}`);
  }
}

function mirrorDir(from: string, to: string): void {
  if (!existsSync(from)) return;
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (entry.isFile()) copyFileSync(join(from, entry.name), join(to, entry.name));
  }
}

function buildSiteIfMissing(distDir: string): void {
  if (existsSync(distDir)) return;
  // playwright.config.ts's webServer runs `astro preview`, which serves dist/
  // verbatim. If dist/ doesn't exist (fresh checkout, no prior `bun run build`),
  // preview falls back behaviorally and the runtime can't fetch its assets.
  // Build deterministically here so e2e is robust to invocation order.
  // Audit-driven (Phase 8 review M2).
  const res = spawnSync("bun", ["--bun", "astro", "build"], {
    cwd: SITE_ROOT,
    stdio: "inherit",
    env: process.env,
  });
  if (res.status !== 0) {
    throw new Error(`globalSetup: astro build exited with status ${res.status}`);
  }
}

export default function globalSetup(): void {
  const distDir = join(SITE_ROOT, "dist");
  runScript("scripts/copy-sqlite-vfs.ts");
  runScript("scripts/build-fixture-db.ts");
  buildSiteIfMissing(distDir);
  // Mirror the freshly built/written artifacts into dist/ so astro preview
  // serves them. (`astro build` already copied public/* once at build time;
  // these mirrors handle the case where build-fixture-db wrote AFTER build.)
  mirrorDir(join(SITE_ROOT, "public", "sqlite-vfs"), join(distDir, "sqlite-vfs"));
  mirrorDir(join(SITE_ROOT, "public", "data"), join(distDir, "data"));
}
