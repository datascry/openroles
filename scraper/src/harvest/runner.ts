import type { ATSId, Tenant } from "@openroles/shared";
import { type HttpClient, HttpError } from "../http.ts";
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
}

export interface HarvestResult {
  readonly ats: ATSId;
  readonly snapshots: ReadonlyArray<string>;
  readonly cdx_records: number;
  readonly cdx_pages_fetched: number;
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
  let fetchErrors = 0;
  let consecutiveErrors = 0;
  const allSlugs = new Set<string>();
  // First-seen metadata across all snapshot pages — extractSlugs already
  // applies the same first-seen-wins rule per page, and we mirror it here
  // so a later page can't override an earlier page's metadata
  // non-deterministically.
  const allMetadata = new Map<string, Record<string, string>>();

  outer: for (const snapshot of opts.snapshots) {
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

  const ordered = Array.from(allSlugs).sort();
  const baseTenants: Tenant[] = opts.skipProbe
    ? ordered.map((slug) => {
        const meta = allMetadata.get(slug);
        const t: Tenant = {
          ats: opts.ats,
          slug,
          status: "transient_failure" as const,
          last_probed_at: opts.observedAt,
        };
        return meta ? { ...t, metadata: meta } : t;
      })
    : await probeMany(opts.ats, ordered, {
        client: opts.client,
        observedAt: opts.observedAt,
        metadataBySlug: allMetadata,
        ...(opts.probeConcurrency !== undefined ? { concurrency: opts.probeConcurrency } : {}),
      });
  // probeMany already merges metadata for composite-URL ATSes (workday /
  // ultipro). For everyone else the harvested metadata bag is still useful
  // (e.g. the workday host), so attach it onto the probed tenant whenever
  // we have a value for that slug and the probe didn't already.
  const tenants: Tenant[] = baseTenants.map((t) => {
    if (t.metadata) return t;
    const meta = allMetadata.get(t.slug);
    return meta ? { ...t, metadata: meta } : t;
  });

  return {
    ats: opts.ats,
    snapshots: opts.snapshots,
    cdx_records: recordCount,
    cdx_pages_fetched: pagesFetched,
    cdx_fetch_errors: fetchErrors,
    unique_slugs: ordered.length,
    tenants,
  };
}
