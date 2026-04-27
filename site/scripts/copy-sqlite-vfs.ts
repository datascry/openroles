#!/usr/bin/env bun
// Copies the sql.js-httpvfs Web Worker and the sql.js WASM blob into
// site/public/sqlite-vfs/ so they're served as static assets at /sqlite-vfs/*.
//
// Bundling them via Vite would inline ~600 KB of code into the main JS chunk,
// which would blow the size-limit gate. They're only loaded on demand by
// client-db.ts, so static-asset hosting is the right shape.

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SITE_ROOT = dirname(HERE);

interface Asset {
  readonly from: string;
  readonly to: string;
}

const ASSETS: ReadonlyArray<Asset> = [
  {
    from: "sql.js-httpvfs/dist/sqlite.worker.js",
    to: "sqlite-vfs/sqlite.worker.js",
  },
  {
    from: "sql.js-httpvfs/dist/sql-wasm.wasm",
    to: "sqlite-vfs/sql-wasm.wasm",
  },
];

function resolveSpecifier(spec: string): string {
  // bun resolves package files via import.meta.resolve; throws if missing.
  const url = import.meta.resolve(spec);
  return fileURLToPath(url);
}

function main(): void {
  const publicDir = join(SITE_ROOT, "public");
  for (const a of ASSETS) {
    const src = resolveSpecifier(a.from);
    const dst = join(publicDir, a.to);
    if (!existsSync(src)) {
      throw new Error(`copy-sqlite-vfs: source not found: ${src}`);
    }
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(src, dst);
    console.log(`copied ${a.from} → public/${a.to}`);
  }
}

main();
