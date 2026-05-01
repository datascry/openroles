import type { HttpClient } from "../http.ts";

const COLLINFO_URL = "https://index.commoncrawl.org/collinfo.json";
const ID_RE = /^CC-MAIN-(\d{4}-\d{2})$/;

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

export async function resolveLatestSnapshots(client: HttpClient, count: number): Promise<string[]> {
  if (count <= 0) return [];
  // Common Crawl's robots.txt blocks the documented public endpoints under
  // index.commoncrawl.org (per https://commoncrawl.org/the-data/get-started/);
  // skip the robots check for this specific host the same way the CDX
  // fetches in runner.ts already do.
  const res = await client.request(COLLINFO_URL, { method: "GET", skipRobots: true });
  const text = await res.text();
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
): Promise<string[]> {
  const res = await client.request(COLLINFO_URL, { method: "GET", skipRobots: true });
  const text = await res.text();
  const all = parseCollInfo(text);
  if (sinceYear === undefined) return all;
  return all.filter((id) => {
    const yr = Number.parseInt(id.slice(0, 4), 10);
    return Number.isFinite(yr) && yr >= sinceYear;
  });
}
