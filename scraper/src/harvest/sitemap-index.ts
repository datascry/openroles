// Platform-sitemap tenant-discovery backend — a second discovery source
// alongside the Common Crawl CDX path (cc-s3.ts + runner.ts).
//
// Some ATS platforms publish a complete, public, auth-free,
// robots-permitted sitemap index that enumerates every hosted tenant.
// Where such an index exists it is a strict superset of what CDX sees
// (CC only records URLs it crawled; the platform lists every board it
// hosts, refreshed daily). This module reads that index and mints tenant
// slugs from it, reusing the connector's harvest-pattern regex so slug
// identity matches the CDX path exactly.
//
// The pure functions take fetched (already-gunzipped) bodies as input and
// never touch the network. `fetchSitemapSlugs` is the thin IO layer with
// an injectable fetch. See specs/sitemap-discovery.md.

import { gunzipSync } from "node:zlib";
import type { ATSId, Tenant } from "@openroles/shared";
import { isSafeFetchHost } from "../ats/common.ts";
import { harvestPatternFor, SLUG_PATTERN } from "./patterns.ts";

// The epoch timestamp a resurrected tenant's `last_probed_at` is reset
// to, so the next reprobe pass (which selects tenants older than
// --max-age-days) picks it up immediately. Using the epoch rather than
// deleting the field keeps the record schema-valid (last_probed_at is
// required).
const EPOCH = "1970-01-01T00:00:00.000Z";

// Minimal fetch shape — GET only, body via `.text()` / `.arrayBuffer()`.
// Same rationale as cc-s3's CcFetcher: avoids coupling to WHATWG's
// `typeof fetch` or Bun's request-init type. `init` carries only the
// redirect mode — child URLs come from an untrusted remote index, so we
// pin `redirect: "manual"` and re-check the final host rather than let a
// legit host 30x into internal infrastructure.
export type SitemapFetcher = (url: string, init?: { redirect?: "manual" }) => Promise<Response>;

/**
 * Extract every `<loc>` URL from a sitemaps.org document — either a
 * `<urlset>` (leaf job URLs) or a `<sitemapindex>` (child documents).
 *
 * Best-effort and resilient: malformed / non-XML / truncated input
 * yields `[]` rather than throwing (a discovery pass must never crash on
 * one bad body). `<loc>` content is trimmed; whitespace-only locs are
 * dropped; the result is de-duplicated with first-seen order preserved
 * so the output is deterministic.
 */
export function parseSitemapIndex(xml: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  // A well-formed <loc> is a single opening/closing pair with a URL
  // between. The inner class is `[^<]` (a URL never contains `<`) and is
  // length-bounded so the match cannot backtrack: with `[\s\S]*?` an
  // input of many unclosed `<loc>` opens (a truncated download — common
  // on the 2,891-child hiringthing sweep) is O(n²) and hangs the process
  // (~85s on 200k opens). `[^<]{0,2048}` makes each attempt O(1) failable
  // — no `<` can appear before `</loc>`, so a `<loc>` with no close fails
  // immediately at the next `<`. 2048 comfortably exceeds any real sitemap
  // URL; a pathologically long loc is simply skipped, never truncated into
  // a bad slug. The closing `</loc>` is still required, so an unclosed
  // trailing tag (truncated body) contributes nothing.
  const re = /<loc>([^<]{0,2048})<\/loc>/gi;
  let m: RegExpExecArray | null = re.exec(xml);
  while (m !== null) {
    const raw = m[1];
    if (raw !== undefined) {
      const url = raw.trim();
      if (url.length > 0 && !seen.has(url)) {
        seen.add(url);
        out.push(url);
      }
    }
    m = re.exec(xml);
  }
  return out;
}

/**
 * Run the connector's harvest-pattern regex against a single `<loc>` and
 * return the first captured, non-deny-listed, `SLUG_PATTERN`-valid slug,
 * or `null`. This is the per-URL form of `extractSlugs` (cdx.ts), so a
 * slug minted from a sitemap `<loc>` is identical to the one CDX would
 * mint for the same host — the two sources merge cleanly into one
 * tenant file.
 *
 * A `<loc>` on the platform's own feed host (e.g. `feeds.isolvedhire.com`)
 * yields `null` because that label is on the connector deny list.
 */
export function extractSlugFromLoc(ats: ATSId, url: string): string | null {
  const pattern = harvestPatternFor(ats);
  // Fresh RegExp per call so we never race on the shared `lastIndex`.
  const re = new RegExp(pattern.regex.source, pattern.regex.flags);
  re.lastIndex = 0;
  let m: RegExpExecArray | null = re.exec(url);
  while (m !== null) {
    const slug = (m[1] ?? m[2] ?? "").toLowerCase();
    if (
      slug.length > 0 &&
      !pattern.denyList.has(slug) &&
      SLUG_PATTERN.test(slug) &&
      matchEndsAtAuthorityBoundary(url, m.index + m[0].length)
    ) {
      return slug;
    }
    m = re.exec(url);
  }
  return null;
}

// A connector host regex (e.g. `…\.applytojob\.com`) matches the platform
// host as a *substring*, so a confusable authority like
// `acme.applytojob.com.evil.com` would otherwise mint slug `acme`. Require
// the character immediately after the matched host to be an authority
// terminator — `/`, `?`, `#`, `:`, or end-of-string — so a further `.label`
// (the attacker's real registrable domain) rejects the match. Path-based
// connectors (smartrecruiters, jobvite, …) already capture up to a `[/?#]`
// boundary inside their own regex, so this check is a no-op harmless
// tightening for them and the real guard for subdomain connectors.
function matchEndsAtAuthorityBoundary(url: string, endIdx: number): boolean {
  if (endIdx >= url.length) return true;
  const next = url[endIdx];
  return next === "/" || next === "?" || next === "#" || next === ":";
}

export interface SitemapSource {
  // Entry-point sitemap URL(s). Multi-page urlset sources (jazzhr's
  // paginated Google feed) list every page here; single-index sources
  // list one.
  readonly indexUrls: ReadonlyArray<string>;
  // Whether child <loc>s must be fetched to recover slugs. `false` when
  // the index <loc>s already carry the slug (subdomain-per-tenant
  // platforms), so one fetch yields every slug.
  readonly descend: boolean;
  // Gunzip children before parsing (`…_sitemap.xml.gz`).
  readonly childIsGzip: boolean;
  // Hard cap on child documents fetched per run (mirrors cc-s3's block
  // cap). Bounds fan-out on a runaway index.
  readonly maxChildren: number;
  // When true, the index asserts *current* liveness: a dead /
  // transient_failure slug that appears in it is resurrected for re-probe
  // (see the CLI merge logic).
  readonly livenessTruth: boolean;
  // Allowed host for CHILD fetches on a descending source. Child <loc>s
  // come from the untrusted remote index, so a poisoned index could point
  // a child at `attacker.evil.com` and turn this into a blind-SSRF fetch
  // from CI. Each child host must equal this host or be a subdomain of it;
  // any other host is rejected before the fetch. Required whenever
  // `descend` is true; unused otherwise.
  readonly childHostAllow?: string;
}

const ISOLVED_INDEX = "https://feeds.isolvedhire.com/site_map_index.xml";
const HIRINGTHING_INDEX =
  "https://s3.amazonaws.com/applicant-tracking-production-sitemap-us-east-1/sitemaps/applicant-tracking_sitemap.xml";
const JAZZHR_FEEDS = [0, 1, 2, 3, 4].map((n) => `https://app.jazz.co/feeds/google/xml/${n}`);

/**
 * Per-ATS sitemap sources. See specs/sitemap-discovery.md for the source
 * table and per-platform rationale (live-confirmed 2026-07-03).
 */
export const SITEMAP_SOURCES: Readonly<Partial<Record<ATSId, SitemapSource>>> = {
  // The index <loc>s are `https://{slug}.isolvedhire.com/job_site_map.xml`,
  // so the slug is recoverable from the index alone — no descent, one
  // request for all ~7,176 tenants.
  isolvedhire: {
    indexUrls: [ISOLVED_INDEX],
    descend: false,
    childIsGzip: false,
    maxChildren: 0,
    livenessTruth: false,
  },
  // The Google feed is a 5-page <urlset> of live job URLs
  // (`https://{slug}.applytojob.com/apply/…`). Every slug present is
  // asserted live today, so this is a liveness-truth source (resurrects
  // our stale dead/transient jazzhr tenants for re-probe).
  jazzhr: {
    indexUrls: JAZZHR_FEEDS,
    descend: false,
    childIsGzip: false,
    maxChildren: 0,
    livenessTruth: true,
  },
  // WEAK: the index keys children by numeric cid, not the subdomain slug
  // our connector uses. The slug is only recoverable by descending into
  // each gzip child (`{slug}.hiringthing.com` appears in the child
  // <loc>s). A full sweep is ~2,891 GET+gunzip, so the default cap keeps
  // a run to a bounded sample; an operator raising --max does a full
  // sweep deliberately.
  hiringthing: {
    indexUrls: [HIRINGTHING_INDEX],
    descend: true,
    childIsGzip: true,
    maxChildren: 200,
    livenessTruth: false,
    // Children live on the same S3 host as the index. Constraining child
    // fetches to this host stops a poisoned index <loc> from redirecting
    // the sweep at an arbitrary external (or internal) host.
    childHostAllow: "s3.amazonaws.com",
  },
};

export function sitemapSourceFor(ats: ATSId): SitemapSource | undefined {
  return SITEMAP_SOURCES[ats];
}

export interface FetchSitemapSlugsOptions {
  readonly ats: ATSId;
  // Optional fetch override for testing. Defaults to globalThis.fetch.
  readonly fetchFn?: SitemapFetcher;
  // Override the source's maxChildren (the CLI's --max). Ignored by
  // non-descending sources.
  readonly maxChildren?: number;
}

export interface FetchSitemapSlugsResult {
  // Slugs minted from the sitemap, sorted and de-duplicated.
  readonly slugs: string[];
  // Number of child documents attempted (descending sources only).
  readonly childrenAttempted: number;
  // Number of children that failed to fetch / gunzip / parse.
  readonly childrenFailed: number;
  // True when the child list was truncated by maxChildren.
  readonly truncated: boolean;
}

// True when `host` equals `allow` or is a subdomain of it (label
// boundary). `a.s3.amazonaws.com` and `s3.amazonaws.com` pass for
// allow=`s3.amazonaws.com`; `s3.amazonaws.com.evil.com` and
// `evils3.amazonaws.com` do not.
function hostAllowed(host: string, allow: string): boolean {
  const h = host.toLowerCase();
  const a = allow.toLowerCase();
  return h === a || h.endsWith(`.${a}`);
}

// Parse + SSRF-guard a URL. Returns null for a malformed URL, a host the
// baseline guard rejects (IP / localhost / metadata / non-https), or —
// when `allow` is supplied — a host that is neither `allow` nor a
// subdomain of it. `allow` is the descend-time child-host constraint:
// child URLs come from the untrusted remote index, so we never fetch a
// host the source didn't sanction.
function safeUrl(url: string, allow?: string): URL | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!isSafeFetchHost(parsed)) return null;
  if (allow !== undefined && !hostAllowed(parsed.hostname, allow)) return null;
  return parsed;
}

// Reject a response that redirected off the allowed host. We fetch with
// `redirect: "manual"`, so a 3xx arrives un-followed; if its Location
// escapes the guard we drop it rather than chase it into internal infra.
// A same-guard redirect target is re-fetched once by the caller path only
// implicitly — we simply refuse cross-guard hops.
function redirectStaysSafe(res: Response, base: string, allow?: string): boolean {
  if (res.status < 300 || res.status >= 400) return true;
  const location = res.headers.get("location");
  if (location === null) return false;
  let target: string;
  try {
    target = new URL(location, base).toString();
  } catch {
    return false;
  }
  return safeUrl(target, allow) !== null;
}

async function fetchBody(
  fetchFn: SitemapFetcher,
  url: string,
  allow?: string,
): Promise<string | null> {
  if (safeUrl(url, allow) === null) return null;
  const res = await fetchFn(url, { redirect: "manual" });
  if (!redirectStaysSafe(res, url, allow)) return null;
  if (!res.ok) return null;
  return await res.text();
}

async function fetchGzipBody(
  fetchFn: SitemapFetcher,
  url: string,
  allow?: string,
): Promise<string | null> {
  if (safeUrl(url, allow) === null) return null;
  const res = await fetchFn(url, { redirect: "manual" });
  if (!redirectStaysSafe(res, url, allow)) return null;
  if (!res.ok) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  return gunzipSync(buf).toString("utf8");
}

// Fetch `url` via `body(fetchFn, url, allow)`, converting any throw
// (network error, gunzip failure) into a null so callers stay flat.
// Returns the body string, or null on any failure / non-2xx / unsafe host
// / off-allow redirect.
async function tryFetch(
  body: (fetchFn: SitemapFetcher, url: string, allow?: string) => Promise<string | null>,
  fetchFn: SitemapFetcher,
  url: string,
  allow?: string,
): Promise<string | null> {
  try {
    return await body(fetchFn, url, allow);
  } catch {
    return null;
  }
}

// Parse a sitemap body and add every slug its <loc>s mint to `into`.
function collectSlugs(ats: ATSId, body: string, into: Set<string>): void {
  for (const loc of parseSitemapIndex(body)) {
    const slug = extractSlugFromLoc(ats, loc);
    if (slug !== null) into.add(slug);
  }
}

// Non-descending source (isolvedhire, jazzhr): every index <loc> already
// carries the slug, so one fetch per index URL yields the slugs directly.
async function fetchDirect(
  ats: ATSId,
  source: SitemapSource,
  fetchFn: SitemapFetcher,
  slugs: Set<string>,
): Promise<void> {
  for (const indexUrl of source.indexUrls) {
    const body = await tryFetch(fetchBody, fetchFn, indexUrl);
    if (body !== null) collectSlugs(ats, body, slugs);
  }
}

// Descending source (hiringthing): fetch the index, then up to `cap`
// child documents (gunzipped when configured), minting slugs from each
// child's <loc>s. A per-child failure drops that one child. Returns the
// running child tallies.
async function fetchDescending(
  ats: ATSId,
  source: SitemapSource,
  fetchFn: SitemapFetcher,
  cap: number,
  slugs: Set<string>,
): Promise<{ childrenAttempted: number; childrenFailed: number; truncated: boolean }> {
  const fetchChild = source.childIsGzip ? fetchGzipBody : fetchBody;
  const childAllow = source.childHostAllow;
  let childrenAttempted = 0;
  let childrenFailed = 0;
  let truncated = false;
  for (const indexUrl of source.indexUrls) {
    const indexBody = await tryFetch(fetchBody, fetchFn, indexUrl);
    if (indexBody === null) continue;
    const childLocs = parseSitemapIndex(indexBody);
    if (childLocs.length > cap) truncated = true;
    for (const childUrl of childLocs.slice(0, cap)) {
      childrenAttempted += 1;
      // childAllow constrains the child host to the source's sanctioned
      // host (or a subdomain) — the untrusted index cannot redirect the
      // sweep off-host.
      const childBody = await tryFetch(fetchChild, fetchFn, childUrl, childAllow);
      if (childBody === null) {
        childrenFailed += 1;
        continue;
      }
      collectSlugs(ats, childBody, slugs);
    }
  }
  return { childrenAttempted, childrenFailed, truncated };
}

/**
 * Fetch a platform's sitemap and mint tenant slugs from it.
 *
 * Non-descending sources (isolvedhire, jazzhr): fetch each index URL and
 * extract a slug from every `<loc>` directly.
 *
 * Descending sources (hiringthing): fetch the index, then fetch up to
 * `maxChildren` child documents (gunzipping when configured), extracting
 * slugs from the children's `<loc>`s. A per-child failure drops that
 * child and continues — partial results are never discarded. Every host
 * passes `isSafeFetchHost` before any request.
 */
export async function fetchSitemapSlugs(
  opts: FetchSitemapSlugsOptions,
): Promise<FetchSitemapSlugsResult> {
  const source = sitemapSourceFor(opts.ats);
  if (source === undefined) {
    throw new Error(`sitemap-index: no sitemap source configured for ats ${opts.ats}`);
  }
  const fetchFn: SitemapFetcher = opts.fetchFn ?? ((url, init) => globalThis.fetch(url, init));
  const slugs = new Set<string>();

  if (!source.descend) {
    await fetchDirect(opts.ats, source, fetchFn, slugs);
    return { slugs: [...slugs].sort(), childrenAttempted: 0, childrenFailed: 0, truncated: false };
  }

  const cap = opts.maxChildren ?? source.maxChildren;
  const tallies = await fetchDescending(opts.ats, source, fetchFn, cap, slugs);
  return { slugs: [...slugs].sort(), ...tallies };
}

export interface MergeSitemapOptions {
  readonly ats: ATSId;
  // Existing tenant records for this ATS (from data/tenants/{ats}.json).
  readonly existing: ReadonlyArray<Tenant>;
  // Slugs the sitemap asserts exist right now.
  readonly sitemapSlugs: ReadonlyArray<string>;
  // Slugs already `live` under a *different* ATS — never seeded here
  // (build-db de-dupes only by exact URL, so a slug live elsewhere would
  // double-count).
  readonly liveElsewhere: ReadonlySet<string>;
  // When true (jazzhr), a dead / transient_failure slug present in the
  // sitemap is resurrected for re-probe.
  readonly livenessTruth: boolean;
  // Discovery timestamp for new / resurrected records.
  readonly now: string;
}

export interface MergeSitemapResult {
  // The merged tenant list, stable-sorted by slug.
  readonly tenants: Tenant[];
  // Slugs newly appended as transient_failure.
  readonly added: number;
  // Existing dead/transient slugs reset to transient_failure (liveness
  // truth only).
  readonly resurrected: number;
  // Sitemap slugs skipped (already present-and-live, or live elsewhere).
  readonly skipped: number;
}

/**
 * Merge a sitemap's slug set into the existing tenant records.
 *
 * - a slug not in the file → appended `status: transient_failure`
 *   (`first_seen_at = last_probed_at = now`), so the reprobe pass
 *   validates it before it counts as live (same as discover-gjobsfeed);
 * - an existing `live` slug → untouched (a sitemap never demotes);
 * - liveness-truth mode: an existing `dead` / `transient_failure` slug
 *   present in the sitemap → `status: transient_failure`,
 *   `last_probed_at` reset to the epoch so the next reprobe re-probes it
 *   immediately (the sitemap asserts it is live now);
 * - a slug already `live` under another ATS → skipped (dedup guard).
 *
 * Pure, deterministic, stable-sorted by slug. Idempotent: re-running with
 * the same inputs adds/resurrects nothing.
 */
export function mergeSitemapSlugs(opts: MergeSitemapOptions): MergeSitemapResult {
  const bySlug = new Map<string, Tenant>();
  for (const t of opts.existing) bySlug.set(t.slug, t);
  let added = 0;
  let resurrected = 0;
  let skipped = 0;

  for (const slug of opts.sitemapSlugs) {
    if (opts.liveElsewhere.has(slug)) {
      skipped += 1;
      continue;
    }
    const cur = bySlug.get(slug);
    if (cur === undefined) {
      bySlug.set(slug, {
        ats: opts.ats,
        slug,
        status: "transient_failure",
        last_probed_at: opts.now,
        first_seen_at: opts.now,
      });
      added += 1;
      continue;
    }
    if (cur.status === "live") {
      skipped += 1;
      continue;
    }
    // Existing dead / transient_failure slug. In liveness-truth mode the
    // sitemap asserts it is live now, so reset it for immediate re-probe —
    // but only when its `last_probed_at` predates this run. A slug already
    // reset to the epoch (a prior resurrection not yet re-probed), or one
    // just seeded at `now` in this same pass, is left as-is; that keeps
    // the merge idempotent and stops a daily run from perpetually yanking
    // a fresh seed's timestamp back before reprobe ever reaches it.
    if (opts.livenessTruth && cur.last_probed_at < opts.now && cur.last_probed_at !== EPOCH) {
      bySlug.set(slug, { ...cur, status: "transient_failure", last_probed_at: EPOCH });
      resurrected += 1;
    } else {
      skipped += 1;
    }
  }

  const tenants = [...bySlug.values()].sort((a, b) => a.slug.localeCompare(b.slug));
  return { tenants, added, resurrected, skipped };
}
