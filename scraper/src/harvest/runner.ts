import type { ATSId, Tenant } from "@openroles/shared";
import { type HttpClient, HttpError } from "../http.ts";
import { type CcFetcher, fetchSnapshotViaS3 } from "./cc-s3.ts";
import {
  buildCdxNumPagesUrl,
  buildCdxUrl,
  type CdxRecord,
  extractSlugs,
  parseCdxJsonLines,
  parseNumPages,
} from "./cdx.ts";
import { harvestPatternFor } from "./patterns.ts";
import { probeMany } from "./probe.ts";

export interface HarvestRunOptions {
  readonly ats: ATSId;
  readonly snapshots: ReadonlyArray<string>;
  readonly client: HttpClient;
  readonly observedAt: string;
  readonly probeConcurrency?: number;
  readonly maxSlugsTotal?: number;
  readonly maxPagesPerSnapshot?: number;
  readonly skipProbe?: boolean;
  // Pause between CDX page fetches to stay under index.commoncrawl.org's
  // rate-limit threshold (empirically ~10 req/s before sustained 5xx).
  // Set 0 to disable; default 250 ms keeps a multi-ATS sweep stable.
  readonly interPageSleepMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  // Existing tenants from prior harvests (incremental mode). When
  // provided, the runner unions newly-discovered slugs with these,
  // preserving each existing tenant's first_seen_at, status, and
  // last_probed_at — i.e. discovery is additive over the corpus
  // instead of regenerating it from scratch.
  // See docs/adr/0011-incremental-harvest-and-reprobe.md.
  readonly existingTenants?: ReadonlyArray<Tenant>;
  // CDX source. Default "http" hits index.commoncrawl.org per-page; "s3"
  // goes through data.commoncrawl.org/cc-index/... and avoids the
  // per-IP throttle that compounds over a multi-snapshot bootstrap.
  // The S3 path returns all records for a snapshot in one shot — no
  // pagination, no inter-page sleep. See cc-s3.ts.
  readonly cdxBackend?: "http" | "s3";
  // Optional immutable-per-collection cache for cluster.idx, used only
  // when cdxBackend="s3". Each cluster.idx is ~100 MB so caching across
  // snapshots in the same run is the difference between minutes and
  // gigabytes of repeated download.
  readonly clusterIdxCache?: {
    get(collection: string): Promise<string | undefined>;
    set(collection: string, body: string): Promise<void>;
  };
}

export interface HarvestResult {
  readonly ats: ATSId;
  readonly snapshots: ReadonlyArray<string>;
  readonly cdx_records: number;
  // Pages fetched on the HTTP backend (`index.commoncrawl.org`). Stays
  // 0 when only the S3 backend ran.
  readonly cdx_pages_fetched: number;
  // Blocks fetched on the S3 backend. 0 when only the HTTP backend ran.
  // Sum of attempted-and-succeeded block fetches across all snapshots.
  readonly cdx_blocks_fetched: number;
  // Number of S3 blocks that the cap (`maxBlocksPerSnapshot`) cut off.
  // Non-zero means we're under-sampling and should either widen the
  // cap or narrow the SURT prefix; surfaced in the run report.
  readonly cdx_blocks_truncated: number;
  readonly cdx_fetch_errors: number;
  readonly unique_slugs: number;
  readonly tenants: ReadonlyArray<Tenant>;
}

const DEFAULT_MAX_SLUGS_TOTAL = 100_000;
const DEFAULT_MAX_PAGES_PER_SNAPSHOT = 50;
const DEFAULT_INTER_PAGE_SLEEP_MS = 250;

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface FetchOutcome {
  readonly records: CdxRecord[];
  readonly errored: boolean;
}

async function fetchCdxPage(client: HttpClient, url: string): Promise<FetchOutcome> {
  try {
    // Common Crawl's index.commoncrawl.org/robots.txt blocks all paths under
    // `/CC-MAIN-*-index` even though those are the documented public CDX API
    // (per https://commoncrawl.org/the-data/get-started/). Skip the robots
    // check for this specific host.
    const res = await client.request(url, { method: "GET", skipRobots: true });
    const text = await res.text();
    return { records: parseCdxJsonLines(text), errored: false };
  } catch (err) {
    if (err instanceof HttpError && err.kind === "permanent" && err.status === 404) {
      return { records: [], errored: false };
    }
    return { records: [], errored: true };
  }
}

async function fetchNumPages(client: HttpClient, url: string): Promise<number> {
  try {
    // Common Crawl's index.commoncrawl.org/robots.txt blocks all paths under
    // `/CC-MAIN-*-index` even though those are the documented public CDX API
    // (per https://commoncrawl.org/the-data/get-started/). Skip the robots
    // check for this specific host.
    const res = await client.request(url, { method: "GET", skipRobots: true });
    const text = await res.text();
    return parseNumPages(text);
  } catch {
    return 1;
  }
}

export async function runHarvest(opts: HarvestRunOptions): Promise<HarvestResult> {
  const pattern = harvestPatternFor(opts.ats);
  const slugCap = opts.maxSlugsTotal ?? DEFAULT_MAX_SLUGS_TOTAL;
  const pageCap = opts.maxPagesPerSnapshot ?? DEFAULT_MAX_PAGES_PER_SNAPSHOT;
  const sleepMs = opts.interPageSleepMs ?? DEFAULT_INTER_PAGE_SLEEP_MS;
  const sleep = opts.sleep ?? defaultSleep;

  let recordCount = 0;
  let pagesFetched = 0;
  let blocksFetched = 0;
  let blocksTruncated = 0;
  let fetchErrors = 0;
  let consecutiveErrors = 0;
  // Tracks whether we've made at least one fetch attempt; used to gate
  // adaptive backoff. Distinct from `pagesFetched`/`blocksFetched` because
  // a failed attempt that yielded zero blocks still counts — we must
  // sleep before retrying the next snapshot, not hammer the upstream.
  let snapshotsAttempted = 0;
  const allSlugs = new Set<string>();
  // First-seen metadata across all snapshot pages — extractSlugs already
  // applies the same first-seen-wins rule per page, and we mirror it here
  // so a later page can't override an earlier page's metadata
  // non-deterministically.
  const allMetadata = new Map<string, Record<string, string>>();

  const useS3 = opts.cdxBackend === "s3";

  // Adapter so cc-s3 (which expects a fetch-shaped function) can use the
  // HarvestRunOptions HttpClient — picks up the configured user-agent,
  // retry policy, and timeouts. data.commoncrawl.org is a public CDN
  // intended for unauthenticated access; skipRobots is appropriate here.
  const s3FetchFn: CcFetcher = async (url, init) => {
    return await opts.client.request(url, {
      method: "GET",
      skipRobots: true,
      ...(init?.headers ? { headers: init.headers } : {}),
    });
  };

  outer: for (const snapshot of opts.snapshots) {
    if (useS3) {
      // Adaptive inter-snapshot backoff: same shape as the HTTP path so
      // a sustained `data.commoncrawl.org` 5xx degrades gracefully instead
      // of hammering CloudFront across 120 snapshots back-to-back. Gated
      // on snapshotsAttempted (not blocksFetched) because a wholly-failed
      // first snapshot still must back off before the second.
      if (snapshotsAttempted > 0 && sleepMs > 0 && consecutiveErrors > 0) {
        await sleep(Math.min(sleepMs * 2 ** consecutiveErrors, 30_000));
      }
      snapshotsAttempted += 1;
      let records: CdxRecord[] = [];
      let snapshotErrored = false;
      try {
        const result = await fetchSnapshotViaS3({
          collection: snapshot,
          cdxQuery: pattern.cdxQuery,
          fetchFn: s3FetchFn,
          ...(opts.clusterIdxCache ? { clusterIdxCache: opts.clusterIdxCache } : {}),
        });
        records = result.records;
        blocksFetched += result.blocksSucceeded;
        if (result.truncated) blocksTruncated += 1;
        // Treat a snapshot as errored when EVERY attempted block failed —
        // that's the catastrophic case (cluster.idx pointed somewhere
        // CloudFront refused, or a network partition). Per-block partial
        // failures (some succeed, some fail) keep the records and don't
        // bump consecutiveErrors — that would be too aggressive.
        if (result.blocksFailed > 0 && result.blocksSucceeded === 0) {
          snapshotErrored = true;
        }
      } catch {
        // Top-level failure (cluster.idx fetch threw, length mismatch,
        // assertion). No records salvageable for this snapshot.
        snapshotErrored = true;
      }
      if (snapshotErrored) {
        fetchErrors += 1;
        consecutiveErrors += 1;
      } else {
        consecutiveErrors = 0;
      }
      recordCount += records.length;
      const { slugs, metadata } = extractSlugs(records, pattern);
      for (const s of slugs) {
        if (allSlugs.size >= slugCap) break outer;
        allSlugs.add(s);
      }
      for (const [slug, meta] of metadata) {
        if (!allMetadata.has(slug)) allMetadata.set(slug, meta);
      }
      continue;
    }

    // HTTP path (default) — per-page through index.commoncrawl.org with
    // adaptive backoff against the per-IP throttle.
    const numPagesUrl = buildCdxNumPagesUrl(snapshot, pattern.cdxQuery);
    const reported = await fetchNumPages(opts.client, numPagesUrl);
    const numPages = Math.min(Math.max(1, reported), pageCap);
    for (let page = 0; page < numPages; page++) {
      if (pagesFetched > 0 && sleepMs > 0) {
        // Adaptive backoff: every consecutive error doubles the inter-page
        // wait, capped at 30 s. Lets the harvester ride out a transient
        // CC rate-limit window without aborting the sweep.
        const adaptive = Math.min(sleepMs * 2 ** consecutiveErrors, 30_000);
        await sleep(adaptive);
      }
      const url = buildCdxUrl(snapshot, pattern.cdxQuery, page);
      const out = await fetchCdxPage(opts.client, url);
      pagesFetched += 1;
      if (out.errored) {
        fetchErrors += 1;
        consecutiveErrors += 1;
      } else {
        consecutiveErrors = 0;
      }
      recordCount += out.records.length;
      const { slugs, metadata } = extractSlugs(out.records, pattern);
      for (const s of slugs) {
        if (allSlugs.size >= slugCap) break outer;
        allSlugs.add(s);
      }
      for (const [slug, meta] of metadata) {
        if (!allMetadata.has(slug)) allMetadata.set(slug, meta);
      }
    }
  }

  const existingBySlug = new Map<string, Tenant>(
    (opts.existingTenants ?? []).map((t) => [t.slug, t]),
  );

  // Build the union of (existing slugs ∪ newly-discovered slugs). Order
  // doesn't matter for the union, only for the final sorted output.
  const unionSlugs = new Set<string>([...existingBySlug.keys(), ...allSlugs]);
  const ordered = Array.from(unionSlugs).sort();

  // Decide which slugs need a probe: in skipProbe mode none of them; in
  // incremental mode only the brand-new ones (existing tenants keep their
  // recorded status). When no existingTenants are passed, fall back to
  // the legacy behavior of probing every slug.
  const isIncremental = opts.existingTenants !== undefined;
  const slugsToProbe = opts.skipProbe
    ? []
    : isIncremental
      ? ordered.filter((s) => !existingBySlug.has(s))
      : ordered;

  const probed: Map<string, Tenant> = new Map();
  if (slugsToProbe.length > 0) {
    const probedTenants = await probeMany(opts.ats, slugsToProbe, {
      client: opts.client,
      observedAt: opts.observedAt,
      metadataBySlug: allMetadata,
      ...(opts.probeConcurrency !== undefined ? { concurrency: opts.probeConcurrency } : {}),
    });
    for (const t of probedTenants) probed.set(t.slug, t);
  }

  const tenants: Tenant[] = ordered.map((slug) => {
    const existing = existingBySlug.get(slug);
    const probedHit = probed.get(slug);
    const meta = allMetadata.get(slug);

    // Existing tenant takes precedence — its status and last_probed_at
    // are carried forward unchanged. New metadata wins over old (so
    // workday `host`/`site` discovered in a later snapshot can fill in
    // a tenant we previously had at transient_failure).
    if (existing) {
      const merged: Tenant = { ...existing };
      if (meta && (!existing.metadata || Object.keys(existing.metadata).length === 0)) {
        merged.metadata = meta;
      }
      return merged;
    }

    // Newly-discovered slug. probedHit handles the live/transient/dead
    // assignment and merges metadata for composite-URL ATSes
    // (workday/ultipro). For path/subdomain ATSes, attach the raw
    // metadata bag we captured during extractSlugs.
    if (probedHit) {
      const enriched: Tenant = { ...probedHit };
      if (!enriched.metadata && meta) enriched.metadata = meta;
      if (!enriched.first_seen_at) enriched.first_seen_at = opts.observedAt;
      return enriched;
    }

    // skipProbe mode — record the slug as transient_failure pending a
    // later reprobe pass. first_seen_at is set to today.
    const t: Tenant = {
      ats: opts.ats,
      slug,
      status: "transient_failure" as const,
      last_probed_at: opts.observedAt,
      first_seen_at: opts.observedAt,
    };
    return meta ? { ...t, metadata: meta } : t;
  });

  return {
    ats: opts.ats,
    snapshots: opts.snapshots,
    cdx_records: recordCount,
    cdx_pages_fetched: pagesFetched,
    cdx_blocks_fetched: blocksFetched,
    cdx_blocks_truncated: blocksTruncated,
    cdx_fetch_errors: fetchErrors,
    unique_slugs: ordered.length,
    tenants,
  };
}
