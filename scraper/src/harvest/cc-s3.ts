// Common Crawl S3-direct backend for CDX harvesting.
//
// Why this exists: `index.commoncrawl.org/CC-MAIN-*-index?url=...` imposes a
// sticky per-IP throttle that compounds over a 120-snapshot historical
// bootstrap. CC's underlying CDX shards live in the public `commoncrawl`
// S3 bucket (anonymous-read), fronted by the CloudFront edge
// `data.commoncrawl.org`. Reading there is unrestricted for tens of GETs.
//
// Pipeline:
//   1. Fetch `cluster.idx` for the collection (cached on disk; immutable).
//   2. Parse the sorted text index, find blocks whose key range covers
//      our SURT prefix. cluster.idx records the FIRST surt key per block,
//      so a prefix match must include the lexicographic-predecessor block
//      too — entries for our prefix can overflow into it from above.
//   3. Range-fetch each block from its shard (`cdx-NNNNN.gz`) — each block
//      is an independent gzip member, so a (offset, length) slice
//      gunzips cleanly.
//   4. Parse CDX-11+JSON lines (`<surt> <timestamp> <json>`), filter by
//      surt prefix (drop predecessor-block entries that don't actually
//      match), and emit `CdxRecord`s in the same shape as the existing
//      HTTP-CDX path.

import { mkdirSync } from "node:fs";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import type { CdxRecord } from "./cdx.ts";

// Collection IDs are CC's `YYYY-NN` (`2026-17`); validating before any
// path-join prevents traversal via a malformed input flowing in from
// collinfo.json or a future caller. Defense in depth — the CLI also
// validates --snapshots, but cc-s3 doesn't trust its callers.
const COLLECTION_ID_RE = /^\d{4}-\d{2}$/;

function assertCollectionId(collection: string): void {
  if (!COLLECTION_ID_RE.test(collection)) {
    throw new Error(`cc-s3: invalid collection id ${JSON.stringify(collection)}`);
  }
}

// Anonymous public CloudFront edge in front of the `commoncrawl` S3 bucket.
// Direct s3://commoncrawl access requires AWS credentials despite the bucket
// being public-read — the docs steer everyone here.
const S3_BASE = "https://data.commoncrawl.org/cc-index/collections";

export interface ClusterIdxBlock {
  readonly shard: string;
  readonly offset: number;
  readonly length: number;
}

export interface Cdx11Record {
  readonly surt: string;
  readonly timestamp: string;
  readonly url: string;
  readonly status: string;
}

// Minimal fetch shape we depend on. Avoids coupling to either WHATWG's
// `typeof fetch` (which requires `preconnect` under TS lib.dom) or Bun's
// `BunFetchRequestInit` — the harvest backend only ever needs GET with
// optional `Range` headers, and getting the body via `.text()` /
// `.arrayBuffer()`.
export type CcFetcher = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<Response>;

export interface FetchSnapshotViaS3Options {
  // Collection id, e.g. "2026-17". The CC-MAIN- prefix is added internally.
  readonly collection: string;
  // Glob from `harvestPatternFor(ats).cdxQuery` — e.g. `boards.greenhouse.io/*`,
  // `*.bamboohr.com/*`. Converted internally to a SURT prefix.
  readonly cdxQuery: string;
  // Optional fetch override for testing. Defaults to `globalThis.fetch`.
  readonly fetchFn?: CcFetcher;
  // Optional cache provider. When supplied, cluster.idx body is loaded
  // from / written to it keyed by collection. cluster.idx is immutable
  // for a given collection so caching is sound forever.
  readonly clusterIdxCache?: {
    get(collection: string): Promise<string | undefined>;
    set(collection: string, body: string): Promise<void>;
  };
  // Hard cap on blocks fetched per snapshot. cluster.idx can yield many
  // matching blocks for an over-broad SURT prefix (e.g. an accidental
  // `cdxQuery: "com,/*"`); without a cap a single bad query can fan out
  // across thousands of blocks and burn hours of bandwidth before any
  // downstream slugCap fires. Default 200 covers the widest legitimate
  // ATS query observed (workday at 21 blocks) with a 10× margin.
  readonly maxBlocksPerSnapshot?: number;
}

const DEFAULT_MAX_BLOCKS_PER_SNAPSHOT = 200;

export interface FetchSnapshotResult {
  // CDX records extracted from blocks that decompressed and parsed.
  readonly records: CdxRecord[];
  // Number of distinct (shard, offset, length) blocks attempted.
  readonly blocksAttempted: number;
  // Number of blocks that contributed records (succeeded fetch + gunzip).
  readonly blocksSucceeded: number;
  // Number of blocks that failed (network error, gunzip throw, etc.).
  // Partial-result mode: a per-block failure does NOT cause the whole
  // snapshot to lose its already-parsed records.
  readonly blocksFailed: number;
  // True when the matching-block list was truncated by maxBlocksPerSnapshot.
  // Surfaced so the caller can warn rather than silently under-sample.
  readonly truncated: boolean;
}

/**
 * Convert a CDX URL glob to its SURT key prefix.
 *
 * The HTTP CDX API accepts globs (`boards.greenhouse.io/*`,
 * `*.bamboohr.com/*`). The S3 path indexes by SURT key (Sort-friendly
 * URI Reordering Transform — labels reversed and comma-joined,
 * terminated by `)` for the host segment).
 *
 *   `boards.greenhouse.io/*`  → `io,greenhouse,boards)/`
 *   `*.bamboohr.com/*`        → `com,bamboohr,`
 *
 * The terminator is `)` for a host-anchored glob (we want exactly that
 * host) and `,` for a wildcard-subdomain glob (we want every key whose
 * next byte is a label separator).
 */
export function cdxQueryToSurtPrefix(cdxQuery: string): string {
  // Strip a trailing /* (or any other path) — only the host segment
  // matters for SURT prefix selection.
  const slashIdx = cdxQuery.indexOf("/");
  const hostPart = slashIdx === -1 ? cdxQuery : cdxQuery.slice(0, slashIdx);
  const wildcard = hostPart.startsWith("*.");
  const domain = wildcard ? hostPart.slice(2) : hostPart;
  const reversedLabels = domain.split(".").reverse().join(",");
  return wildcard ? `${reversedLabels},` : `${reversedLabels})/`;
}

/**
 * Parse one line of the CDX-11+JSON format:
 *   `<surt-key> <timestamp> <json-blob>`
 *
 * Returns null for blank lines or malformed entries (the parser is a
 * best-effort filter — bad lines are silently dropped to keep the
 * harvest resilient against occasional corruption).
 */
export function parseCdx11Line(line: string): Cdx11Record | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  // The JSON blob always starts with `{`; before that are surt + timestamp
  // separated by spaces. Splitting on the first `{` gives us a clean
  // header to tokenize without worrying about spaces inside JSON values.
  const jsonStart = trimmed.indexOf("{");
  if (jsonStart === -1) return null;
  const header = trimmed.slice(0, jsonStart).trim();
  const jsonText = trimmed.slice(jsonStart);
  const parts = header.split(/\s+/);
  if (parts.length < 2) return null;
  const surt = parts[0];
  const timestamp = parts[1];
  if (surt === undefined || timestamp === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  const url = obj["url"];
  if (typeof url !== "string") return null;
  const status = obj["status"];
  return {
    surt,
    timestamp,
    url,
    status: typeof status === "string" ? status : "",
  };
}

/**
 * Find the cluster.idx blocks that could contain entries with surt keys
 * starting with `prefix`.
 *
 * Each cluster.idx line is the FIRST surt key in a block. Entries whose
 * surt > line[k] but < line[k+1] live inside line[k]'s block. So our
 * answer is:
 *   - every line whose first-surt starts with `prefix`, AND
 *   - the lexicographic-predecessor line if its first-surt < prefix
 *     (entries for our prefix could overflow into that block from above)
 *
 * We don't return the predecessor when prefix > all keys (no block could
 * contain it).
 */
export function findClusterIdxBlocks(clusterIdx: string, prefix: string): ClusterIdxBlock[] {
  const out: ClusterIdxBlock[] = [];
  const lines = clusterIdx.split(/\r?\n/);
  let predecessor: ClusterIdxBlock | null = null;
  let predecessorKey = "";
  let foundDirectMatch = false;

  for (const raw of lines) {
    if (raw.length === 0) continue;
    // Real cluster.idx format: `<surt><space><timestamp>\t<shard>\t<offset>\t<length>\t<line-count>`.
    // The first column is two tokens joined by a literal space; the rest
    // are tab-separated. Split tabs first, then peel off the surt key
    // from the leading "surt timestamp" pair.
    const cols = raw.split("\t");
    if (cols.length < 4) continue;
    const head = cols[0];
    const shard = cols[1];
    const offsetStr = cols[2];
    const lengthStr = cols[3];
    if (
      head === undefined ||
      shard === undefined ||
      offsetStr === undefined ||
      lengthStr === undefined
    ) {
      continue;
    }
    const spaceIdx = head.indexOf(" ");
    const key = spaceIdx === -1 ? head : head.slice(0, spaceIdx);
    const offset = Number.parseInt(offsetStr, 10);
    const length = Number.parseInt(lengthStr, 10);
    if (!Number.isFinite(offset) || !Number.isFinite(length)) continue;

    const block: ClusterIdxBlock = { shard, offset, length };
    if (key.startsWith(prefix)) {
      if (!foundDirectMatch && predecessor !== null && predecessorKey < prefix) {
        // Adjacent predecessor block could contain prefix entries that
        // overflowed from above; include it before the first direct hit.
        out.push(predecessor);
      }
      foundDirectMatch = true;
      out.push(block);
    } else if (!foundDirectMatch) {
      // Track the most recent block whose key < prefix. We may need it
      // as a predecessor.
      if (key < prefix) {
        predecessor = block;
        predecessorKey = key;
      }
    } else {
      // Past the prefix range; remaining blocks can't help.
      break;
    }
  }

  // No direct hits at all: include the predecessor if its key < prefix
  // (entries for our prefix could be inside it). If predecessor is null
  // OR all keys are > prefix, no block can contain our data.
  if (!foundDirectMatch && predecessor !== null) {
    out.push(predecessor);
  }
  return out;
}

async function fetchClusterIdx(
  collection: string,
  fetchFn: CcFetcher,
  cache?: FetchSnapshotViaS3Options["clusterIdxCache"],
): Promise<string> {
  assertCollectionId(collection);
  if (cache) {
    const hit = await cache.get(collection);
    if (hit !== undefined) return hit;
  }
  const url = `${S3_BASE}/CC-MAIN-${collection}/indexes/cluster.idx`;
  const res = await fetchFn(url);
  if (!res.ok) {
    throw new Error(`cc-s3: cluster.idx fetch ${res.status} for ${collection}`);
  }
  const body = await res.text();
  // Integrity check: Content-Length is required by S3 / CloudFront on
  // unconditional GETs. A truncated body (mid-stream connection drop)
  // would silently poison the cache forever, since `res.text()` happily
  // returns whatever bytes arrived. Reject the response when length
  // disagrees with the body the kernel handed us.
  const expected = res.headers.get("content-length");
  if (expected !== null) {
    const expectedNum = Number.parseInt(expected, 10);
    const actual = Buffer.byteLength(body, "utf8");
    if (Number.isFinite(expectedNum) && expectedNum > 0 && actual !== expectedNum) {
      throw new Error(
        `cc-s3: cluster.idx length mismatch for ${collection} ` +
          `(expected ${expectedNum} bytes, got ${actual}); ` +
          `refusing to poison the cache`,
      );
    }
  }
  if (cache) await cache.set(collection, body);
  return body;
}

async function fetchBlockBytes(
  collection: string,
  block: ClusterIdxBlock,
  fetchFn: CcFetcher,
): Promise<Buffer> {
  assertCollectionId(collection);
  const url = `${S3_BASE}/CC-MAIN-${collection}/indexes/${block.shard}`;
  const end = block.offset + block.length - 1;
  const res = await fetchFn(url, {
    headers: { Range: `bytes=${block.offset}-${end}` },
  });
  // S3 returns 206 Partial Content on success; some intermediaries serve
  // 200 with the full body. Either is acceptable as long as we got bytes.
  if (!res.ok && res.status !== 206) {
    throw new Error(`cc-s3: block fetch ${res.status} for ${block.shard}`);
  }
  const buf = await res.arrayBuffer();
  return Buffer.from(buf);
}

/**
 * Build a disk-backed cache for cluster.idx files. Each collection's
 * cluster.idx is ~100 MB and immutable, so a one-time download per
 * collection (not per ATS, not per snapshot pass) is the difference
 * between minutes and 264+ GB across a 22-ATS × 120-snapshot bootstrap.
 *
 * Layout: <dir>/cluster-idx/<collection>.idx — flat files keyed by
 * collection id (e.g. "2026-17.idx"). Writes go through a sibling
 * `<collection>.idx.tmp.<pid>.<rand>` then atomic-rename so:
 *   - a process crash mid-write never leaves a half-written .idx
 *   - concurrent writers (e.g. CI matrix legs harvesting different ATSes
 *     against the same collection) never observe each other's partial
 *     bytes — rename is a single inode swap; only one wins, and the loser
 *     just produces an identical valid file
 *   - a reader is guaranteed either the full previous content or the
 *     full new content, never a truncation
 */
export function diskClusterIdxCache(dir: string): {
  get(collection: string): Promise<string | undefined>;
  set(collection: string, body: string): Promise<void>;
} {
  const cacheDir = join(dir, "cluster-idx");
  return {
    get: async (collection) => {
      assertCollectionId(collection);
      const path = join(cacheDir, `${collection}.idx`);
      // No `existsSync` precheck — let readFile's ENOENT take the catch
      // path. That keeps the "missing file" branch covered by tests
      // without needing an unreliable permissions hack to cover a
      // separate post-existsSync catch.
      try {
        return await readFile(path, "utf8");
      } catch {
        return undefined;
      }
    },
    set: async (collection, body) => {
      assertCollectionId(collection);
      const final = join(cacheDir, `${collection}.idx`);
      const tmp = `${final}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 10)}`;
      mkdirSync(cacheDir, { recursive: true });
      try {
        await writeFile(tmp, body);
        await rename(tmp, final);
      } catch {
        // Cache write is best-effort; failure is non-fatal. Best-effort
        // cleanup of the temp file so we don't leak ~100 MB on a partial
        // write. `rm({ force: true })` swallows ENOENT itself, so no
        // inner catch needed.
        /* c8 ignore next */
        await rm(tmp, { force: true });
      }
    },
  };
}

/**
 * Fetch all CDX records for one collection matching `cdxQuery` via the
 * S3-direct path. Returns partial results when individual blocks fail —
 * a single corrupted slice or transient network error on block N must
 * NOT discard the records already harvested from blocks 0..N-1. The
 * caller can inspect `blocksFailed` and `truncated` to decide whether
 * the snapshot is "good enough" or warrants a retry.
 */
export async function fetchSnapshotViaS3(
  opts: FetchSnapshotViaS3Options,
): Promise<FetchSnapshotResult> {
  const fetchFn: CcFetcher = opts.fetchFn ?? ((url, init) => globalThis.fetch(url, init));
  const blockCap = opts.maxBlocksPerSnapshot ?? DEFAULT_MAX_BLOCKS_PER_SNAPSHOT;
  const prefix = cdxQueryToSurtPrefix(opts.cdxQuery);
  const clusterIdx = await fetchClusterIdx(opts.collection, fetchFn, opts.clusterIdxCache);
  const allBlocks = findClusterIdxBlocks(clusterIdx, prefix);
  const truncated = allBlocks.length > blockCap;
  const blocks = truncated ? allBlocks.slice(0, blockCap) : allBlocks;
  if (blocks.length === 0) {
    return { records: [], blocksAttempted: 0, blocksSucceeded: 0, blocksFailed: 0, truncated };
  }

  // Dedupe identical (shard, offset, length) tuples — defensive against
  // an idx where two adjacent keys point at the same physical block.
  const seen = new Set<string>();
  const records: CdxRecord[] = [];
  let blocksAttempted = 0;
  let blocksSucceeded = 0;
  let blocksFailed = 0;
  for (const block of blocks) {
    const key = `${block.shard}@${block.offset}+${block.length}`;
    if (seen.has(key)) continue;
    seen.add(key);
    blocksAttempted += 1;
    let compressed: Buffer;
    try {
      compressed = await fetchBlockBytes(opts.collection, block, fetchFn);
    } catch {
      blocksFailed += 1;
      continue;
    }
    let decompressed: string;
    try {
      decompressed = gunzipSync(compressed).toString("utf8");
    } catch {
      // Stale offset, partial-content drop, or genuine corruption — drop
      // this one block, keep the records we already have, continue.
      blocksFailed += 1;
      continue;
    }
    for (const line of decompressed.split(/\r?\n/)) {
      const r = parseCdx11Line(line);
      if (r === null) continue;
      // The block may include lines outside our prefix (predecessor
      // overflow, or lines that don't actually start with prefix even
      // in a direct-match block). Filter strictly.
      if (!r.surt.startsWith(prefix)) continue;
      records.push({ url: r.url, status: r.status, timestamp: r.timestamp });
    }
    blocksSucceeded += 1;
  }
  return { records, blocksAttempted, blocksSucceeded, blocksFailed, truncated };
}
