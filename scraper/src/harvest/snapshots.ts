import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { HttpClient } from "../http.ts";

const COLLINFO_URL = "https://index.commoncrawl.org/collinfo.json";
const ID_RE = /^CC-MAIN-(\d{4}-\d{2})$/;
// CC publishes new snapshots ~every 5 weeks, so a 24h cache of collinfo.json
// is plenty fresh and avoids re-querying the index server (which IP-throttles
// for minutes after a heavy CDX sweep). The cache file lives next to the
// per-ATS state files. See ADR-0011 and the bootstrap notes in
// specs/harvest-incremental.md.
const COLLINFO_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface CollInfoEntry {
  readonly id?: unknown;
  readonly name?: unknown;
}

export function parseCollInfo(body: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const ids: string[] = [];
  for (const entry of parsed as ReadonlyArray<CollInfoEntry>) {
    const id = entry.id;
    if (typeof id !== "string") continue;
    const m = ID_RE.exec(id);
    if (m && typeof m[1] === "string") ids.push(m[1]);
  }
  return ids.sort().reverse();
}

export interface CollInfoCacheOptions {
  // Where to read/write the cached collinfo body. When undefined the cache
  // is bypassed entirely (legacy callers, tests).
  readonly cacheDir?: string;
  // Override now-ms for testability.
  readonly now?: () => number;
}

async function readCollInfoCache(cacheDir: string, nowMs: number): Promise<string | undefined> {
  const path = join(cacheDir, "_collinfo.json");
  try {
    const stat = await import("node:fs/promises").then((m) => m.stat(path));
    if (nowMs - stat.mtimeMs > COLLINFO_CACHE_TTL_MS) return undefined;
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

async function writeCollInfoCache(cacheDir: string, body: string): Promise<void> {
  const path = join(cacheDir, "_collinfo.json");
  try {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(cacheDir, { recursive: true });
    await writeFile(path, body);
    /* c8 ignore next 3 — cache write best-effort; failure is non-fatal. */
  } catch {
    // ignore — cache is best-effort
  }
}

async function fetchOrCacheCollInfo(
  client: HttpClient,
  opts: CollInfoCacheOptions = {},
): Promise<string> {
  const nowMs = (opts.now ?? Date.now)();
  if (opts.cacheDir) {
    const cached = await readCollInfoCache(opts.cacheDir, nowMs);
    if (cached !== undefined) return cached;
  }
  // Common Crawl's robots.txt blocks the documented public endpoints under
  // index.commoncrawl.org (per https://commoncrawl.org/the-data/get-started/);
  // skip the robots check for this specific host the same way the CDX
  // fetches in runner.ts already do.
  try {
    const res = await client.request(COLLINFO_URL, { method: "GET", skipRobots: true });
    const text = await res.text();
    if (opts.cacheDir) await writeCollInfoCache(opts.cacheDir, text);
    return text;
  } catch (err) {
    // Fall back to a stale cache if one exists — better than aborting the
    // whole harvest because CC's index server is currently rate-limiting us.
    if (opts.cacheDir) {
      const stale = await readFile(join(opts.cacheDir, "_collinfo.json"), "utf8").catch(
        () => undefined,
      );
      if (stale !== undefined) {
        console.error(
          `harvest: collinfo.json fetch failed (${(err as Error).message}); using stale cache`,
        );
        return stale;
      }
    }
    throw err;
  }
}

export async function resolveLatestSnapshots(
  client: HttpClient,
  count: number,
  opts: CollInfoCacheOptions = {},
): Promise<string[]> {
  if (count <= 0) return [];
  const text = await fetchOrCacheCollInfo(client, opts);
  return parseCollInfo(text).slice(0, count);
}

/**
 * Resolve every CC-MAIN snapshot id available in collinfo.json, sorted
 * newest-first. Optionally filter to snapshots whose year is >= sinceYear
 * (e.g. `2008` for the full historical bootstrap, `2020` for a four-year
 * incremental window). Used by the incremental-harvest flow in
 * docs/adr/0011 to compute the diff against per-ATS state files.
 */
export async function resolveAllSnapshots(
  client: HttpClient,
  sinceYear?: number,
  opts: CollInfoCacheOptions = {},
): Promise<string[]> {
  const text = await fetchOrCacheCollInfo(client, opts);
  const all = parseCollInfo(text);
  if (sinceYear === undefined) return all;
  return all.filter((id) => {
    const yr = Number.parseInt(id.slice(0, 4), 10);
    return Number.isFinite(yr) && yr >= sinceYear;
  });
}
