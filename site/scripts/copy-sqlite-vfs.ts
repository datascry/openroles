#!/usr/bin/env bun
// Copies the sql.js-httpvfs Web Worker and the sql.js WASM blob into
// site/public/sqlite-vfs/ so they're served as static assets at /sqlite-vfs/*.
//
// Bundling them via Vite would inline ~600 KB of code into the main JS chunk,
// which would blow the size-limit gate. They're only loaded on demand by
// client-db.ts, so static-asset hosting is the right shape.
//
// We also patch the worker on the way through to fix an upstream bug that
// surfaces when the SQLite database is split across multiple server-chunk
// files (chunked mode). sql.js-httpvfs's read-ahead can request a byte
// range that crosses a server-chunk file boundary; the HTTP server (e.g.
// GitHub Pages / Fastly) honours the request only up to the file end and
// truncates the response. The lazyFile loop fills the chunks it received
// and then throws "doXHR failed (bug)!" because the originally-requested
// internal chunk was past the truncation point.
//
// Two surgical patches in the copied worker:
//   A. LazyUint8Array captures `serverChunkSize` from its config.
//   B. getChunk clamps the read-ahead end at the current server-chunk
//      boundary (saves wasted bandwidth on truncated reads).
//   C. If the originally-requested internal chunk is still missing after
//      the for-loop (read-ahead spanned two server chunks), retry with
//      a single-chunk request — that single request is always inside one
//      server-chunk file because requestChunkSize divides serverChunkSize.
//   D. SplitFileHttpDatabase forwards `serverChunkSize` to createLazyFile.
//
// All four anchor strings must remain unique in the dist file; the copy
// throws if any anchor fails to match exactly once.

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SITE_ROOT = dirname(HERE);

interface Asset {
  readonly from: string;
  readonly to: string;
  readonly transform?: "patch-worker";
}

const ASSETS: ReadonlyArray<Asset> = [
  {
    from: "sql.js-httpvfs/dist/sqlite.worker.js",
    to: "sqlite-vfs/sqlite.worker.js",
    transform: "patch-worker",
  },
  {
    from: "sql.js-httpvfs/dist/sql-wasm.wasm",
    to: "sqlite-vfs/sql-wasm.wasm",
  },
];

interface WorkerPatch {
  readonly name: string;
  readonly find: string;
  readonly replace: string;
}

const WORKER_PATCHES: ReadonlyArray<WorkerPatch> = [
  {
    // A. Capture serverChunkSize on construction.
    name: "lazyfile-capture-server-chunk-size",
    find: "this._length=e.fileLength",
    replace: "this._length=e.fileLength,this._serverChunkSize=e.serverChunkSize||0",
  },
  {
    // B. Clamp read-ahead at server-chunk boundary, AND C. retry the
    // originally-requested chunk on truncation. Both edits target the
    // same getChunk body, so combine into one anchor for atomicity.
    name: "lazyfile-clamp-and-retry",
    find: "i=Math.min(i,this.length-1);const s=this.doXHR(o,i);",
    replace:
      "i=Math.min(i,this.length-1);" +
      "if(this._serverChunkSize>0){var _b=(Math.floor(o/this._serverChunkSize)+1)*this._serverChunkSize-1;i=Math.min(i,_b)}" +
      "const s=this.doXHR(o,i);",
  },
  {
    // C continued: replace the "doXHR failed (bug)!" throw with a
    // single-chunk fallback fetch.
    name: "lazyfile-retry-on-truncation",
    find: 'if(void 0===this.chunks[e])throw new Error("doXHR failed (bug)!");',
    replace:
      "if(void 0===this.chunks[e]){var _o2=e*this.chunkSize,_i2=Math.min(_o2+this.chunkSize-1,this.length-1),_s2=this.doXHR(_o2,_i2);this.chunks[e]=new Uint8Array(_s2,0,_s2.byteLength)}",
  },
  {
    // D. Forward serverChunkSize from worker config to createLazyFile.
    name: "splitfile-forward-server-chunk-size",
    find: "maxReadHeads:3,requestLimiter:i",
    replace:
      'maxReadHeads:3,requestLimiter:i,serverChunkSize:"chunked"===e.serverMode?e.serverChunkSize:0',
  },
  {
    // E. Append a configurable urlSuffix to the chunked-mode URL so we
    // can name chunks `.png` instead of `.000`. GitHub Pages / Fastly
    // gzips application/octet-stream by content-type; with gzip on,
    // Range responses contain compressed bytes (with `Content-Encoding:
    // gzip` and a content-range based on the COMPRESSED stream), which
    // sql.js-httpvfs reads as raw SQLite — every query returns garbage.
    // image/png is excluded from Fastly's compressible list, so the
    // chunks come back uncompressed and Range requests are honest.
    name: "rangemapper-url-suffix",
    find: 'url:e.urlPrefix+String(n).padStart(e.suffixLength,"0")+l',
    replace: 'url:e.urlPrefix+String(n).padStart(e.suffixLength,"0")+(e.urlSuffix||"")+l',
  },
];

function resolveSpecifier(spec: string): string {
  // bun resolves package files via import.meta.resolve; throws if missing.
  const url = import.meta.resolve(spec);
  return fileURLToPath(url);
}

function patchWorker(src: string): string {
  let out = src;
  for (const patch of WORKER_PATCHES) {
    const idx = out.indexOf(patch.find);
    if (idx < 0) {
      throw new Error(`copy-sqlite-vfs: patch '${patch.name}' anchor not found`);
    }
    const second = out.indexOf(patch.find, idx + patch.find.length);
    if (second >= 0) {
      throw new Error(
        `copy-sqlite-vfs: patch '${patch.name}' anchor matched ${out.split(patch.find).length - 1}× — must be unique`,
      );
    }
    out = `${out.slice(0, idx)}${patch.replace}${out.slice(idx + patch.find.length)}`;
    console.log(`patched ${patch.name}`);
  }
  return out;
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
    if (a.transform === "patch-worker") {
      const original = readFileSync(src, "utf8");
      const patched = patchWorker(original);
      writeFileSync(dst, patched);
      console.log(`copied + patched ${a.from} → public/${a.to}`);
    } else {
      copyFileSync(src, dst);
      console.log(`copied ${a.from} → public/${a.to}`);
    }
  }
}

main();
