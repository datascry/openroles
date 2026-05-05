// Playwright globalSetup: provision the fixture SQLite + manifest +
// slim-index chunks. Writes into both public/ (for `astro dev` and
// future builds) and dist/ (for `astro preview` against the existing
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
    const src = join(from, entry.name);
    const dst = join(to, entry.name);
    if (entry.isFile()) {
      copyFileSync(src, dst);
    } else if (entry.isDirectory()) {
      // Recurse — the slim-index emitter writes content-hashed chunks
      // under data/slim/ and `astro preview` serves dist/ verbatim,
      // so without descending we'd ship the manifest pointing at
      // chunks that aren't on disk and FilterTable would 404 every
      // chunk fetch.
      mirrorDir(src, dst);
    }
  }
}

function ensureSiteFresh(distDir: string): void {
  // playwright.config.ts's webServer runs `astro preview`, which serves dist/
  // verbatim. Rebuild when:
  //   1. dist/ does not exist (fresh checkout / no prior `bun run build`), or
  //   2. dist/data/ is missing — slim-index chunks land there at build time
  //      from the fixture DB; if globalSetup ran AFTER the first build the
  //      chunks will be in public/data but not dist/data.
  // Build is ~2s; cheap enough that "rebuild on any doubt" beats subtle
  // staleness.
  if (existsSync(distDir) && existsSync(join(distDir, "data"))) return;
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
  runScript("scripts/build-fixture-db.ts");
  ensureSiteFresh(distDir);
  // Mirror the freshly written artifacts into dist/ so astro preview
  // serves them. (`astro build` already copied public/* once at build time;
  // these mirrors handle the case where build-fixture-db wrote AFTER build.)
  mirrorDir(join(SITE_ROOT, "public", "data"), join(distDir, "data"));
}
