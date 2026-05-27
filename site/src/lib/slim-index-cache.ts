/**
 * Persistent cache for the merged slim-index `SlimRow[]`.
 *
 * Why this exists: the Service Worker at `public/sw.js` cache-firsts
 * the gzipped chunk responses, so revisits skip the network entirely.
 * But the *processing* — decompressing 45 × ~1.4 MB gzip, JSON-parsing
 * each chunk, mapping `fromWire`, structured-cloning across the worker
 * boundary, merging into the canonical row array — still costs ~5 s of
 * CPU on every reload. That's what the user sees as "the loading bar
 * starts over." The SW saves bytes; this layer saves the CPU work
 * downstream of those bytes.
 *
 * Strategy: store the canonical `SlimRow[]` keyed by the current
 * `manifest.short_sha`. On revisit, restore directly from IndexedDB
 * and skip the worker pipeline entirely. The manifest is still fetched
 * (network-first, ~kilobytes) so we always know the current sha; a
 * sha mismatch (data refreshed overnight) treats the cache as cold.
 *
 * Trade-offs:
 *   - structuredClone of ~865 k rows through IDB is ~30–80 ms on a
 *     real device, vs ~5 s for the full worker pipeline. ~50× speedup
 *     on warm reload.
 *   - On IDB unavailability (SSR, private mode in some browsers,
 *     hostile storage policy), `createRowsCache()` returns a
 *     null-object cache so call sites stay branch-free.
 *
 * Testing layout: the IDB-specific code lives in `slim-index-cache-idb.ts`
 * and is excluded from coverage (no IDB polyfill in bun:test). The
 * IDB happy-path is exercised end-to-end by Playwright. The interface
 * contract — "load returns null when empty, save + clear don't throw"
 * — is unit-tested here via `NULL_CACHE`.
 */

import type { SlimRow } from "./slim-index.ts";
import { idbRowsCache } from "./slim-index-cache-idb.ts";

export interface RowsCache {
  /**
   * Return cached rows for `short_sha` if and only if a matching
   * entry exists AND the cached `total_rows` count equals
   * `expected_total`. Any storage error resolves to `null`.
   */
  load(shortSha: string, expectedTotal: number): Promise<SlimRow[] | null>;
  /**
   * Persist `rows` under `short_sha`, dropping any prior entries.
   * Fire-and-forget from the caller's perspective: errors swallowed.
   */
  save(shortSha: string, rows: ReadonlyArray<SlimRow>): Promise<void>;
  /**
   * Drop every cached entry. Used by the "reset all" affordance and
   * by tests.
   */
  clear(): Promise<void>;
}

/**
 * No-op cache used when IndexedDB isn't available (SSR, private mode,
 * etc.). The factory selects this implementation transparently so call
 * sites don't need to handle the unsupported case themselves.
 */
export const NULL_CACHE: RowsCache = {
  load: async () => null,
  save: async () => {
    // intentional no-op — interface contract is async
  },
  clear: async () => {
    // intentional no-op — interface contract is async
  },
};

/**
 * Factory: return an IDB-backed cache when IndexedDB is available,
 * otherwise the `NULL_CACHE` no-op. Call sites can store the result
 * once and use it without checking.
 */
export function createRowsCache(): RowsCache {
  if (typeof indexedDB === "undefined") return NULL_CACHE;
  return idbRowsCache();
}
