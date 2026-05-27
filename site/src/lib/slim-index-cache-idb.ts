/**
 * IndexedDB implementation of the rows cache. Lives in its own module
 * so it can be excluded from bun:test coverage via
 * `coveragePathIgnorePatterns` in bunfig.toml — bun:test has no IDB
 * polyfill, and the cost of adding one (fake-indexeddb is ~MBs of
 * vendor code) outweighs the value here. The IDB happy-path is
 * exercised end-to-end by Playwright against real Chromium.
 *
 * Public API is intentionally one factory function; the interface
 * contract lives in `slim-index-cache.ts`.
 */

import type { SlimRow } from "./slim-index.ts";
import type { RowsCache } from "./slim-index-cache.ts";

const DB_NAME = "openroles-slim-cache" as const;
const DB_VERSION = 1;
const STORE = "rows" as const;

interface CachedEntry {
  readonly short_sha: string;
  readonly total_rows: number;
  readonly rows: ReadonlyArray<SlimRow>;
  readonly ts: number;
}

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "short_sha" });
      }
    };
    req.onsuccess = () => {
      resolve(req.result);
    };
    req.onerror = () => {
      resolve(null);
    };
    req.onblocked = () => {
      resolve(null);
    };
  });
}

export function idbRowsCache(): RowsCache {
  return {
    async load(shortSha, expectedTotal) {
      const db = await openDb();
      if (db === null) return null;
      try {
        return await new Promise<SlimRow[] | null>((resolve) => {
          // Defensive: an empty/undefined key throws synchronously from
          // IDBObjectStore.get. The cache is best-effort — never let a
          // bad key (e.g. caller forgot to populate manifest.short_sha)
          // bubble up into the user-visible "could not load" path.
          let req: IDBRequest;
          try {
            req = db.transaction(STORE, "readonly").objectStore(STORE).get(shortSha);
          } catch {
            resolve(null);
            return;
          }
          req.onsuccess = () => {
            const v = req.result as CachedEntry | undefined;
            if (v === undefined) {
              resolve(null);
              return;
            }
            if (v.total_rows !== expectedTotal) {
              resolve(null);
              return;
            }
            resolve(v.rows as SlimRow[]);
          };
          req.onerror = () => {
            resolve(null);
          };
        });
      } finally {
        db.close();
      }
    },
    async save(shortSha, rows) {
      const db = await openDb();
      if (db === null) return;
      try {
        await new Promise<void>((resolve) => {
          const t = db.transaction(STORE, "readwrite");
          const store = t.objectStore(STORE);
          // Drop everything else; only the current corpus is useful.
          store.clear();
          const entry: CachedEntry = {
            short_sha: shortSha,
            total_rows: rows.length,
            rows,
            ts: Date.now(),
          };
          store.put(entry);
          t.oncomplete = () => {
            resolve();
          };
          t.onerror = () => {
            resolve();
          };
          t.onabort = () => {
            resolve();
          };
        });
      } finally {
        db.close();
      }
    },
    async clear() {
      const db = await openDb();
      if (db === null) return;
      try {
        await new Promise<void>((resolve) => {
          const t = db.transaction(STORE, "readwrite");
          t.objectStore(STORE).clear();
          t.oncomplete = () => {
            resolve();
          };
          t.onerror = () => {
            resolve();
          };
          t.onabort = () => {
            resolve();
          };
        });
      } finally {
        db.close();
      }
    },
  };
}
