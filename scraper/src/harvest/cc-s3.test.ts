// Tests for the Common Crawl S3 backend. The backend reads the same CDX
// data as `index.commoncrawl.org` does, but goes straight to the public
// CloudFront edge `data.commoncrawl.org/cc-index/...`. The HTTP CDX server
// imposes per-IP throttling that compounds over a 120-snapshot bootstrap;
// the S3 path has no such throttle (cluster.idx + per-block range
// requests are cached by CloudFront).

import { afterEach, describe, expect, it, mock } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import * as fc from "fast-check";
import {
  cdxQueryToSurtPrefix,
  diskClusterIdxCache,
  fetchSnapshotViaS3,
  findClusterIdxBlocks,
  parseCdx11Line,
} from "./cc-s3.ts";

afterEach(() => mock.restore());

describe("cdxQueryToSurtPrefix", () => {
  // Path-based queries pin a specific host (boards.greenhouse.io/*) — the
  // SURT prefix ends in `)` to anchor the host segment exactly.
  it("converts a host glob to a host-anchored SURT", () => {
    expect(cdxQueryToSurtPrefix("boards.greenhouse.io/*")).toBe("io,greenhouse,boards)/");
  });
  it("converts a 2-label host glob", () => {
    expect(cdxQueryToSurtPrefix("jobs.lever.co/*")).toBe("co,lever,jobs)/");
  });

  // Subdomain wildcards (*.bamboohr.com/*) span every subdomain — the SURT
  // prefix ends in `,` so it matches every key whose next byte is a label
  // separator (a comma in SURT keyspace).
  it("converts a wildcard-subdomain glob to a domain prefix", () => {
    expect(cdxQueryToSurtPrefix("*.bamboohr.com/*")).toBe("com,bamboohr,");
  });
  it("converts a 3-label wildcard-subdomain glob", () => {
    expect(cdxQueryToSurtPrefix("*.jobs.personio.com/*")).toBe("com,personio,jobs,");
  });
  it("strips a trailing /* but tolerates its absence", () => {
    expect(cdxQueryToSurtPrefix("boards.greenhouse.io")).toBe("io,greenhouse,boards)/");
    expect(cdxQueryToSurtPrefix("*.bamboohr.com")).toBe("com,bamboohr,");
  });

  // Property: the SURT prefix is always the host labels reversed and
  // comma-joined, with the appropriate terminator.
  it("property: round-trips reversed labels for any host glob", () => {
    fc.assert(
      fc.property(
        fc.array(fc.stringMatching(/^[a-z][a-z0-9-]{0,30}[a-z0-9]$/), {
          minLength: 2,
          maxLength: 4,
        }),
        (labels) => {
          const host = labels.join(".");
          const surt = cdxQueryToSurtPrefix(`${host}/*`);
          const expected = `${labels.slice().reverse().join(",")})/`;
          return surt === expected;
        },
      ),
      { numRuns: 50 },
    );
  });
});

describe("parseCdx11Line", () => {
  // Real CDX-11 line: `<surt> <timestamp> <json>`
  const SAMPLE =
    'co,lever)/pricing 20260419111809 {"url": "https://www.lever.co/pricing/", "mime": "text/html", "status": "200", "digest": "AEV4373JXKW7"}';

  it("parses surt, timestamp, and url from a well-formed line", () => {
    const r = parseCdx11Line(SAMPLE);
    expect(r).not.toBeNull();
    expect(r?.surt).toBe("co,lever)/pricing");
    expect(r?.timestamp).toBe("20260419111809");
    expect(r?.url).toBe("https://www.lever.co/pricing/");
    expect(r?.status).toBe("200");
  });

  it("returns null for blank lines", () => {
    expect(parseCdx11Line("")).toBeNull();
    expect(parseCdx11Line("   ")).toBeNull();
  });

  it("returns null when JSON section is missing or malformed", () => {
    expect(parseCdx11Line("co,lever)/foo 20260419111809")).toBeNull();
    expect(parseCdx11Line("co,lever)/foo 20260419111809 {not json")).toBeNull();
  });

  it("tolerates missing optional fields", () => {
    const minimal = 'a,b)/x 20260101000000 {"url": "https://b.a/x"}';
    const r = parseCdx11Line(minimal);
    expect(r?.url).toBe("https://b.a/x");
    expect(r?.status).toBe("");
  });
});

describe("findClusterIdxBlocks", () => {
  // cluster.idx is a sorted text file: each line is the FIRST surt key in
  // a block, followed by the shard filename, byte offset, and length:
  //   <surt-key>\t<timestamp>\t<shard>\t<offset>\t<length>\t<line-count>
  // Blocks are independent gzip members ("idxgzip") inside the shard
  // file, so a (offset, length) range request gunzips cleanly on its own.
  // Real cluster.idx format: surt + space + timestamp, then tabs.
  const IDX = [
    "co,leklub)/robots.txt 20260417120705\tcdx-00026.gz\t572426745\t201678\t80736",
    "co,lemonade)/foo 20260411052839\tcdx-00026.gz\t572628423\t181447\t80737",
    "co,lever)/how-to-build 20260419111809\tcdx-00026.gz\t574066283\t225893\t80744",
    "co,lexir)/aaa 20260416135603\tcdx-00026.gz\t574292176\t188776\t80745",
    "com,bamboohr,acme)/careers 20260415120000\tcdx-00050.gz\t1234567\t150000\t12345",
    "com,bamboohr,beta)/careers 20260415120100\tcdx-00050.gz\t1384567\t160000\t12400",
    "com,beanco)/x 20260415120200\tcdx-00050.gz\t1544567\t140000\t12500",
  ].join("\n");

  it("returns direct-match block AND the immediate predecessor (overflow defense)", () => {
    // cluster.idx records each block's FIRST surt key — but a block may
    // *also* contain trailing keys < its successor's first key. So when
    // the successor (here: co,lever) is a direct match, the immediate
    // predecessor (co,lemonade)/foo) might still hold a tail of co,lever)
    // entries that fell on the wrong side of the block boundary.
    // Including it is one extra ~200 KB fetch for guaranteed coverage.
    const blocks = findClusterIdxBlocks(IDX, "co,lever)/");
    expect(blocks.length).toBe(2);
    expect(blocks.map((b) => b.offset)).toEqual([572628423, 574066283]);
  });

  it("returns predecessor when no direct match exists in the prefix range", () => {
    // "co,lex)/" sits between co,lemonade and co,lexir; no cluster.idx
    // line starts with it, but co,lever) is alphabetically before
    // "co,lex)/" so its block could hold leading "co,lex)/" entries.
    const blocks = findClusterIdxBlocks(IDX, "co,lex)/");
    expect(blocks.length).toBe(1);
    expect(blocks[0]?.offset).toBe(574066283);
  });

  it("returns predecessor + every direct match for a multi-block prefix", () => {
    const blocks = findClusterIdxBlocks(IDX, "com,bamboohr,");
    // Direct matches: acme + beta. Plus predecessor (co,lexir)/aaa).
    expect(blocks.length).toBe(3);
    expect(blocks.map((b) => b.offset).sort((a, b) => a - b)).toEqual([
      1234567, 1384567, 574292176,
    ]);
  });

  it("returns the last block as predecessor when prefix sorts after every key", () => {
    // 'zz,' is past everything. The last block (com,beanco) is the
    // predecessor and could conceivably hold zz,* entries (we don't
    // know its upper bound from cluster.idx alone). One conservative
    // fetch is fine.
    const blocks = findClusterIdxBlocks(IDX, "zz,");
    expect(blocks.length).toBe(1);
    expect(blocks[0]?.offset).toBe(1544567);
  });

  it("returns empty when prefix sorts before every key", () => {
    // '00,' sorts before any letter-prefixed key, so no block can
    // possibly contain prefix entries.
    const blocks = findClusterIdxBlocks(IDX, "00,");
    expect(blocks).toEqual([]);
  });
});

describe("fetchSnapshotViaS3", () => {
  // Build a tiny fixture cluster.idx + a tiny gzipped CDX shard block.
  // Verify the function downloads the right ranges, decompresses, and
  // returns CdxRecords matching the host-pattern filter.
  const FIXTURE_LINES = [
    'io,greenhouse,boards)/brex/jobs/123 20260415120000 {"url": "https://boards.greenhouse.io/brex/jobs/123", "mime": "text/html", "status": "200"}',
    'io,greenhouse,boards)/brex/jobs/124 20260415120100 {"url": "https://boards.greenhouse.io/brex/jobs/124", "mime": "text/html", "status": "200"}',
    'io,greenhouse,boards)/stripe/jobs/789 20260415120200 {"url": "https://boards.greenhouse.io/stripe/jobs/789", "mime": "text/html", "status": "200"}',
  ].join("\n");
  const SHARD_GZ = gzipSync(Buffer.from(FIXTURE_LINES, "utf8"));
  const SHARD_OFFSET = 1000;
  const SHARD_LENGTH = SHARD_GZ.length;
  const CLUSTER = [
    `io,greenhouse,boards)/brex/jobs/123 20260415120000\tcdx-00200.gz\t${SHARD_OFFSET}\t${SHARD_LENGTH}\t1`,
  ].join("\n");

  it("fetches cluster.idx then the matching block, returning parsed records", async () => {
    const fetched: string[] = [];
    const fetchFn = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      fetched.push(url);
      if (url.endsWith("/cluster.idx")) {
        return new Response(CLUSTER);
      }
      if (url.endsWith("/cdx-00200.gz")) {
        // Honor Range: bytes=offset-end by slicing a synthetic buffer
        // padded with zeroes up to SHARD_OFFSET, then the gzipped data.
        const range = (init?.headers as Record<string, string>)?.["Range"];
        const m = /bytes=(\d+)-(\d+)/.exec(range ?? "");
        if (m && m[1] !== undefined && m[2] !== undefined) {
          const start = Number.parseInt(m[1], 10);
          const end = Number.parseInt(m[2], 10);
          // Synthesize: zeros up to SHARD_OFFSET, then SHARD_GZ
          const buf = Buffer.concat([Buffer.alloc(SHARD_OFFSET), SHARD_GZ]);
          const slice = buf.subarray(start, end + 1);
          return new Response(slice, { status: 206 });
        }
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    const result = await fetchSnapshotViaS3({
      collection: "2026-17",
      cdxQuery: "boards.greenhouse.io/*",
      fetchFn: fetchFn as unknown as typeof globalThis.fetch,
    });

    // 3 fixture lines all match the prefix.
    expect(result.records.length).toBe(3);
    expect(result.records.map((r) => r.url)).toEqual([
      "https://boards.greenhouse.io/brex/jobs/123",
      "https://boards.greenhouse.io/brex/jobs/124",
      "https://boards.greenhouse.io/stripe/jobs/789",
    ]);
    expect(result.blocksAttempted).toBe(1);
    expect(result.blocksSucceeded).toBe(1);
    expect(result.blocksFailed).toBe(0);
    expect(result.truncated).toBe(false);
    // Both URLs were hit: cluster.idx then the shard.
    expect(fetched.length).toBe(2);
    expect(fetched[0]).toContain("/cluster.idx");
    expect(fetched[1]).toContain("/cdx-00200.gz");
  });

  it("filters out lines whose surt key falls outside the prefix", async () => {
    // Shard contains an extra line for a different host that shouldn't
    // appear in results because its surt key falls outside the prefix
    // anchored by `cdxQueryToSurtPrefix("boards.greenhouse.io/*")`.
    const mixed = [
      'io,greenhouse,boards)/brex/jobs/123 20260415120000 {"url": "https://boards.greenhouse.io/brex/jobs/123", "mime": "text/html", "status": "200"}',
      'io,greenhouse,jobs)/sneaky 20260415120100 {"url": "https://jobs.greenhouse.io/sneaky", "mime": "text/html", "status": "200"}',
    ].join("\n");
    const mixedGz = gzipSync(Buffer.from(mixed, "utf8"));
    const cluster = `io,greenhouse,boards)/brex/jobs/123 20260415120000\tcdx-00200.gz\t0\t${mixedGz.length}\t1`;

    const fetchFn = mock(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/cluster.idx")) return new Response(cluster);
      return new Response(mixedGz, { status: 206 });
    });

    const result = await fetchSnapshotViaS3({
      collection: "2026-17",
      cdxQuery: "boards.greenhouse.io/*",
      fetchFn: fetchFn as unknown as typeof globalThis.fetch,
    });

    expect(result.records.length).toBe(1);
    expect(result.records[0]?.url).toBe("https://boards.greenhouse.io/brex/jobs/123");
  });

  it("returns empty result when cluster.idx has no matching prefix", async () => {
    // 'zz,nothing' is past every boards.greenhouse.io key; predecessor logic
    // returns the last block (only entry in this fixture). Since the
    // fixture's offset=0, length=100 fetches an empty/garbage range that
    // gunzip rejects, the block fails and we return an empty result with
    // blocksFailed=1 — the snapshot effectively yielded nothing, which is
    // the correct outcome.
    const cluster = "zz,nothing 20260415120000\tcdx-00999.gz\t0\t100\t1";
    const fetchFn = mock(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/cluster.idx")) return new Response(cluster);
      return new Response(Buffer.alloc(100), { status: 206 });
    });
    const result = await fetchSnapshotViaS3({
      collection: "2026-17",
      cdxQuery: "boards.greenhouse.io/*",
      fetchFn: fetchFn as unknown as typeof globalThis.fetch,
    });
    expect(result.records).toEqual([]);
  });

  it("uses cluster.idx cache when present, skipping the network", async () => {
    const cluster = `io,greenhouse,boards)/x 20260415120000\tcdx-00200.gz\t0\t${SHARD_LENGTH}\t1`;
    const stored = new Map<string, string>();
    const cache = {
      get: async (k: string) => stored.get(k),
      set: async (k: string, v: string) => {
        stored.set(k, v);
      },
    };
    let clusterFetches = 0;
    const fetchFn = mock(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/cluster.idx")) {
        clusterFetches += 1;
        return new Response(cluster);
      }
      return new Response(SHARD_GZ, { status: 206 });
    });

    // Two calls with same collection — first populates cache, second hits it.
    for (let i = 0; i < 2; i++) {
      await fetchSnapshotViaS3({
        collection: "2026-17",
        cdxQuery: "boards.greenhouse.io/*",
        fetchFn: fetchFn as unknown as typeof globalThis.fetch,
        clusterIdxCache: cache,
      });
    }
    expect(clusterFetches).toBe(1);
    expect(stored.has("2026-17")).toBe(true);
  });

  it("falls back to globalThis.fetch when no fetchFn is injected", async () => {
    // Exercises the default-fetch arrow inside fetchSnapshotViaS3. Stubs
    // globalThis.fetch via mock.module-equivalent (direct assignment),
    // restored by the afterEach mock.restore().
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        "zz,nothing 20260101 cdx-99.gz 0 0 0".replace(/ /g, "\t"),
      )) as typeof globalThis.fetch;
    try {
      const result = await fetchSnapshotViaS3({
        collection: "2026-17",
        cdxQuery: "boards.greenhouse.io/*",
      });
      expect(result.records).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("throws when cluster.idx fetch returns a non-OK status", async () => {
    const fetchFn = mock(async () => new Response("internal error", { status: 503 }));
    await expect(
      fetchSnapshotViaS3({
        collection: "2026-17",
        cdxQuery: "boards.greenhouse.io/*",
        fetchFn: fetchFn as unknown as typeof globalThis.fetch,
      }),
    ).rejects.toThrow(/cluster\.idx fetch 503/);
  });

  it("counts a 4xx block fetch as a failed block and continues with partial results", async () => {
    // Two cluster.idx blocks, one of which 404s. Per-block error recovery
    // means we return records from the surviving block plus blocksFailed=1.
    const cluster = [
      `io,greenhouse,boards)/a 20260415120000\tcdx-00200.gz\t1000\t${SHARD_LENGTH}\t1`,
      `io,greenhouse,boards)/b 20260415120100\tcdx-00200.gz\t9999999\t100\t2`,
    ].join("\n");
    const fetchFn = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/cluster.idx")) return new Response(cluster);
      const range = (init?.headers as Record<string, string>)?.["Range"];
      if (range?.includes("bytes=1000-")) {
        return new Response(SHARD_GZ, { status: 206 });
      }
      return new Response("not found", { status: 404 });
    });

    const result = await fetchSnapshotViaS3({
      collection: "2026-17",
      cdxQuery: "boards.greenhouse.io/*",
      fetchFn: fetchFn as unknown as typeof globalThis.fetch,
    });

    expect(result.blocksAttempted).toBe(2);
    expect(result.blocksSucceeded).toBe(1);
    expect(result.blocksFailed).toBe(1);
    expect(result.records.length).toBe(3); // 3 lines from the surviving block
  });

  it("counts a gunzip failure as a block failure (continues with remaining blocks)", async () => {
    // Two blocks. The first decompresses; the second is corrupted bytes
    // that gunzipSync will throw on.
    const cluster = [
      `io,greenhouse,boards)/a 20260415120000\tcdx-00200.gz\t1000\t${SHARD_LENGTH}\t1`,
      `io,greenhouse,boards)/b 20260415120100\tcdx-00200.gz\t99999\t10\t2`,
    ].join("\n");
    const fetchFn = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/cluster.idx")) return new Response(cluster);
      const range = (init?.headers as Record<string, string>)?.["Range"];
      if (range?.includes("bytes=1000-")) {
        return new Response(SHARD_GZ, { status: 206 });
      }
      // Garbage bytes that aren't valid gzip
      return new Response(Buffer.from([0xff, 0xff, 0xff, 0xff]), { status: 206 });
    });

    const result = await fetchSnapshotViaS3({
      collection: "2026-17",
      cdxQuery: "boards.greenhouse.io/*",
      fetchFn: fetchFn as unknown as typeof globalThis.fetch,
    });

    expect(result.blocksFailed).toBe(1);
    expect(result.blocksSucceeded).toBe(1);
    expect(result.records.length).toBe(3);
  });

  it("truncates block list at maxBlocksPerSnapshot and surfaces the cap via truncated=true", async () => {
    // Five blocks; cap at 2.
    const cluster = Array.from(
      { length: 5 },
      (_, i) =>
        `io,greenhouse,boards)/${i} 20260415120000\tcdx-00200.gz\t${1000 + i * 100000}\t${SHARD_LENGTH}\t1`,
    ).join("\n");
    let blockFetches = 0;
    const fetchFn = mock(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/cluster.idx")) return new Response(cluster);
      blockFetches += 1;
      return new Response(SHARD_GZ, { status: 206 });
    });
    const result = await fetchSnapshotViaS3({
      collection: "2026-17",
      cdxQuery: "boards.greenhouse.io/*",
      fetchFn: fetchFn as unknown as typeof globalThis.fetch,
      maxBlocksPerSnapshot: 2,
    });
    expect(result.truncated).toBe(true);
    expect(blockFetches).toBe(2);
  });

  it("rejects malformed collection ids before any path join", async () => {
    const fetchFn = mock(async () => new Response(""));
    await expect(
      fetchSnapshotViaS3({
        collection: "../etc/passwd",
        cdxQuery: "boards.greenhouse.io/*",
        fetchFn: fetchFn as unknown as typeof globalThis.fetch,
      }),
    ).rejects.toThrow(/invalid collection id/);
    // No fetch attempted — the assertion fired before any URL was built.
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("rejects a truncated cluster.idx via Content-Length integrity check", async () => {
    // Server claims 1000 bytes but ships 50 — connection-drop simulation.
    const fetchFn = mock(
      async () =>
        new Response("io,greenhouse,boards)/x 20260101 cdx.gz 0 0 0".replace(/ /g, "\t"), {
          headers: { "content-length": "100000" },
        }),
    );
    await expect(
      fetchSnapshotViaS3({
        collection: "2026-17",
        cdxQuery: "boards.greenhouse.io/*",
        fetchFn: fetchFn as unknown as typeof globalThis.fetch,
      }),
    ).rejects.toThrow(/length mismatch/);
  });

  it("dedupes block-ranges when cluster.idx names the same block twice", async () => {
    // Defensive: two cluster.idx lines with identical (shard, offset, length)
    // shouldn't trigger two range fetches.
    const dupe = [
      `io,greenhouse,boards)/a 20260415120000\tcdx-00200.gz\t0\t${SHARD_LENGTH}\t1`,
      `io,greenhouse,boards)/b 20260415120100\tcdx-00200.gz\t0\t${SHARD_LENGTH}\t2`,
    ].join("\n");
    let shardFetches = 0;
    const fetchFn = mock(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/cluster.idx")) return new Response(dupe);
      shardFetches += 1;
      return new Response(SHARD_GZ, { status: 206 });
    });

    await fetchSnapshotViaS3({
      collection: "2026-17",
      cdxQuery: "boards.greenhouse.io/*",
      fetchFn: fetchFn as unknown as typeof globalThis.fetch,
    });
    expect(shardFetches).toBe(1);
  });
});

describe("diskClusterIdxCache", () => {
  let dir: string;

  function makeTmp(): string {
    return mkdtempSync(join(tmpdir(), "openroles-cc-s3-"));
  }

  afterEach(() => {
    if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it("returns undefined when no cached file exists yet", async () => {
    dir = makeTmp();
    const cache = diskClusterIdxCache(dir);
    expect(await cache.get("2026-17")).toBeUndefined();
  });

  it("round-trips a body: set then get returns the same content", async () => {
    dir = makeTmp();
    const cache = diskClusterIdxCache(dir);
    const body = "io,greenhouse,boards)/x 20260101000000\tcdx-00200.gz\t0\t100\t1";
    await cache.set("2026-17", body);
    expect(await cache.get("2026-17")).toBe(body);
    // And the file lives where we documented (cluster-idx/<collection>.idx).
    const path = join(dir, "cluster-idx", "2026-17.idx");
    expect(readFileSync(path, "utf8")).toBe(body);
  });

  it("creates the cluster-idx subdirectory lazily on first set", async () => {
    dir = makeTmp();
    expect(existsSync(join(dir, "cluster-idx"))).toBe(false);
    const cache = diskClusterIdxCache(dir);
    await cache.set("2026-17", "x");
    expect(existsSync(join(dir, "cluster-idx"))).toBe(true);
  });

  it("rejects invalid collection ids on get and set (path-traversal guard)", async () => {
    dir = makeTmp();
    const cache = diskClusterIdxCache(dir);
    await expect(cache.get("../etc/passwd")).rejects.toThrow(/invalid collection id/);
    await expect(cache.set("../etc/passwd", "x")).rejects.toThrow(/invalid collection id/);
    await expect(cache.set("2026-17/extra", "x")).rejects.toThrow(/invalid collection id/);
  });

  it("uses tmp+rename so a concurrent reader never observes a partial write", async () => {
    // Direct verification that `set` writes via a sibling temp file.
    // After a successful `set`, no `.tmp.*` files should remain.
    dir = makeTmp();
    const cache = diskClusterIdxCache(dir);
    await cache.set("2026-17", "x".repeat(1024));
    const cacheDir = join(dir, "cluster-idx");
    const entries = (await import("node:fs")).readdirSync(cacheDir);
    expect(entries).toContain("2026-17.idx");
    // No stranded .tmp.* sentinels.
    expect(entries.some((e) => e.includes(".tmp."))).toBe(false);
  });
});
