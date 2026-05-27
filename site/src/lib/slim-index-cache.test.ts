import { describe, expect, it } from "bun:test";
import { createRowsCache, NULL_CACHE } from "./slim-index-cache.ts";

/**
 * Unit tests for the cache module. Bun:test has no IndexedDB
 * polyfill, so `createRowsCache()` returns the `NULL_CACHE` no-op
 * here — and that IS one of the paths real users hit (SSR build,
 * private-mode browsers, hostile storage policy). The IDB path is
 * exercised end-to-end by site/tests/e2e/reload-cache.spec.ts
 * against real Chromium where `indexedDB` is defined.
 */

describe("createRowsCache", () => {
  it("falls back to NULL_CACHE when IndexedDB is unavailable", () => {
    expect(typeof indexedDB).toBe("undefined");
    const cache = createRowsCache();
    expect(cache).toBe(NULL_CACHE);
  });
});

describe("NULL_CACHE", () => {
  it("load always resolves to null", async () => {
    expect(await NULL_CACHE.load("abc123", 100)).toBeNull();
    expect(await NULL_CACHE.load("", 0)).toBeNull();
  });

  it("save resolves without throwing", async () => {
    await expect(NULL_CACHE.save("abc123", [])).resolves.toBeUndefined();
  });

  it("clear resolves without throwing", async () => {
    await expect(NULL_CACHE.clear()).resolves.toBeUndefined();
  });
});

describe("createRowsCache with stub IDB present", () => {
  it("delegates to the IDB factory when indexedDB is defined", () => {
    // Inject a minimal stub so the `typeof indexedDB === 'undefined'`
    // branch isn't taken, exercising the call into the IDB factory.
    // The factory's body lives in slim-index-cache-idb.ts (excluded
    // from coverage); we only need to verify the dispatch here.
    const original = (globalThis as { indexedDB?: unknown }).indexedDB;
    (globalThis as { indexedDB?: unknown }).indexedDB = {} as IDBFactory;
    try {
      const cache = createRowsCache();
      expect(cache).not.toBe(NULL_CACHE);
      expect(typeof cache.load).toBe("function");
      expect(typeof cache.save).toBe("function");
      expect(typeof cache.clear).toBe("function");
    } finally {
      if (original === undefined) {
        delete (globalThis as { indexedDB?: unknown }).indexedDB;
      } else {
        (globalThis as { indexedDB?: unknown }).indexedDB = original;
      }
    }
  });
});
