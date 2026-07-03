# Tenant discovery via platform sitemap indexes

## Why

Tenant discovery is otherwise driven by the Common Crawl CDX index
(`scraper/src/harvest/cc-s3.ts` + `runner.ts`): CC records only the URLs
it happened to crawl, so for high-volume SMB platforms it captures a
partial slice of live tenants — typically 30-50% short on platforms with
long tails of small boards that CC rarely reaches.

Some ATS platforms publish a **complete, public, auth-free,
robots-permitted sitemap index** that enumerates every hosted tenant.
Where such an index exists it is a strict superset of what CDX can see:
the platform itself lists every board it hosts, refreshed daily
(`<lastmod>` tracks the day). This backend reads that index as a second
discovery source alongside CDX.

The sitemap source and the CDX source share slug identity: slug
extraction reuses the connector's harvest-pattern regex
(`harvestPatternFor(ats).regex` via `extractSlugs`), so a slug found in a
sitemap `<loc>` is the same string CDX would mint for the same host. This
keeps the two sources mergeable into one `data/tenants/{ats}.json`.

## The two shapes of sitemap

The generic sitemaps.org schema has two document types, and platforms mix
them:

1. **`<urlset>`** — a flat list of `<url><loc>…</loc></url>` job-page
   URLs. Each `<loc>` carries a `{slug}` (subdomain or path segment). One
   fetch yields every slug on the platform.
2. **`<sitemapindex>`** — a list of `<sitemap><loc>…</loc></sitemap>`
   entries, each pointing at a *child* document (another `<urlset>` or a
   nested `<sitemapindex>`). Children may be gzip-compressed
   (`…_sitemap.xml.gz`).

The parser handles both. A `<sitemapindex>` whose child `<loc>`s already
carry the slug (subdomain-per-tenant platforms like isolvedhire, where
the index lists `https://{slug}.isolvedhire.com/…`) needs **no child
fetch** — the slug is recoverable from the index alone, so those backends
set `descend: false` and every slug comes from one cheap request. A
`<sitemapindex>` whose child `<loc>`s are opaque (a numeric id, e.g.
hiringthing's `cid_{NNNNNNNN}_sitemap.xml.gz`) requires descending into
each child to recover the `{slug}.host` — bounded by `maxChildren`. Descent
is **single-level**: the index lists leaf `<urlset>` children, and the
backend fetches those children only. It does not recurse into a
nested `<sitemapindex>` child; none of the three configured sources
nests, and if a future source did, the nested child would simply
yield no slugs (its `<loc>`s are sitemap URLs, not job URLs, which
`extractSlugFromLoc` rejects) rather than being silently descended.

## Pure module — `scraper/src/harvest/sitemap-index.ts`

No network. All IO is the caller's; the pure functions take fetched
bodies (already-gunzipped strings) as input.

- `parseSitemapIndex(xml): string[]` — extract every `<loc>` URL from a
  sitemaps.org document (either `<urlset>` or `<sitemapindex>`). Tolerant
  of malformed XML: returns `[]` rather than throwing. Deterministic,
  order-preserving, de-duplicated. The `<loc>` regex uses a
  **length-bounded, `<`-excluding** inner class (`[^<]{0,2048}`) so a
  truncated body of many unclosed `<loc>` opens cannot trigger
  catastrophic backtracking (an unbounded lazy class was O(n²) — ~85s on
  200k opens; the bound makes each attempt O(1)-failable). A URL never
  contains `<` and is well under 2048 chars, so real sitemaps are
  unaffected; a pathologically long loc is skipped, never truncated into a
  bad slug.
- `extractSlugFromLoc(ats, url): string | null` — run
  `harvestPatternFor(ats).regex` against one `<loc>` and return the first
  captured, non-deny-listed, `SLUG_PATTERN`-valid slug, or `null`. This
  is the same extraction `extractSlugs` performs for CDX, applied to a
  single URL, so slug identity is shared across the two sources. A `<loc>`
  that names the platform's own feed host (e.g.
  `feeds.isolvedhire.com`) yields `null` because `feeds` is on the
  connector deny list. The match must end at an **authority boundary**
  (`/`, `?`, `#`, `:`, or end-of-string) so a confusable host like
  `acme.applytojob.com.evil.com` — where the platform domain is a mere
  substring — does not mint the slug `acme`.

## Per-ATS config — `SITEMAP_SOURCES`

A map `ats → { indexUrls, descend, childIsGzip, maxChildren, livenessTruth, childHostAllow? }`:

- `indexUrls` — the public sitemap entry point(s) (a urlset source may
  paginate across several, e.g. jazzhr's five feed pages).
- `descend` — whether child `<loc>`s must be fetched to recover slugs
  (`false` when the index `<loc>`s already carry the slug).
- `childIsGzip` — gunzip children before parsing (`node:zlib gunzipSync`).
- `maxChildren` — hard cap on child documents fetched (mirrors cc-s3's
  block cap), so a runaway index can never fan out unboundedly.
- `livenessTruth` — when `true`, the index asserts *current* liveness
  (see below).
- `childHostAllow` — required for a descending source: child `<loc>`s
  come from the untrusted remote index, so each child host must equal this
  host or be a subdomain of it. Any other host is rejected before the
  fetch, closing the blind-SSRF vector a poisoned index would otherwise
  open (for hiringthing this is `s3.amazonaws.com`).

## IO — `fetchSitemapSlugs(opts)`

Thin IO wrapper with an injectable `fetchFn` (defaults to
`globalThis.fetch`). Fetches `indexUrls`, parses them, and:

- non-descending source (`descend: false`, isolvedhire/jazzhr): extracts a
  slug from every index `<loc>` directly;
- descending source (`descend: true`, hiringthing): fetches up to
  `maxChildren` child documents (gunzipping when `childIsGzip`), parses
  each, and extracts slugs from the child `<loc>`s. Single-level only (see
  above).

SSRF defenses: every fetched host passes `isSafeFetchHost` (rejects IP
literals / localhost / metadata / non-https). Child fetches additionally
require `childHostAllow`. All fetches use `redirect: "manual"` and the
final target of any 3xx is re-checked against the same guard, so a legit
host cannot 30x the sweep into internal infrastructure. A per-child
fetch/gunzip/parse/redirect failure drops that child and continues —
partial results are never discarded.

## CLI — `discover-sitemap --ats <id> [--tenants-file <path>] [--max N] [--dry-run]`

1. Resolve the `SITEMAP_SOURCES` entry for `--ats`; unknown/unsupported
   ATS → exit 2.
2. `fetchSitemapSlugs` to get the current slug set (capped by `--max`,
   default the source's `maxChildren`). `--max` only bounds child-sitemap
   descent; on a non-descending source (isolvedhire/jazzhr) it has no
   effect and the command prints a one-line notice rather than silently
   ignoring it.
3. Merge into `data/tenants/{ats}.json` (or `--tenants-file`):
   - **new slug** (not in the file) → appended as
     `status: transient_failure`, `first_seen_at = last_probed_at = now`.
     The reprobe pass validates it before it counts as live — identical
     to how `discover-gjobsfeed` seeds.
   - **existing `live` slug** → untouched (the sitemap does not demote).
   - **liveness-truth mode** (`livenessTruth: true`): an existing
     `dead` / `transient_failure` slug that appears in the sitemap is
     *resurrected* — `status` set to `transient_failure` and
     `last_probed_at` cleared to the epoch (`1970-01-01T00:00:00.000Z`)
     so the next reprobe pass re-probes it immediately (the sitemap
     asserts it is live *now*, overriding a stale `dead`).
   - Cross-ATS dedup guard: a slug already `live` under another ATS is
     not seeded (build-db de-dupes only by exact URL).
4. Deterministic, stable-sorted by slug; idempotent (re-running seeds
   nothing new). `--dry-run` computes and prints the summary without
   writing.
5. Print `fetched=… new=… resurrected=… skipped=…`.

## Per-ATS sources (live-confirmed 2026-07-03)

| ats          | index                                                                                          | shape                                   | descend | our tenants | mode           |
|--------------|------------------------------------------------------------------------------------------------|-----------------------------------------|---------|-------------|----------------|
| isolvedhire  | `feeds.isolvedhire.com/site_map_index.xml`                                                      | `<sitemapindex>`, ~7,176 slug-bearing `<loc>` | no      | 3           | seed net-new   |
| jazzhr       | `app.jazz.co/feeds/google/xml/{0..4}`                                                           | 5 × `<urlset>`, ~7,200 subdomains       | n/a     | ~8,273      | liveness-truth |
| hiringthing  | `s3.amazonaws.com/applicant-tracking-production-sitemap-us-east-1/sitemaps/applicant-tracking_sitemap.xml` | `<sitemapindex>`, ~2,891 gzip children keyed by numeric `cid` | yes     | ~a handful  | seed net-new   |

### isolvedhire — seed net-new

The index `<loc>`s already carry the slug
(`https://{slug}.isolvedhire.com/job_site_map.xml`), so `descend: false`
and one ~7,176-entry fetch yields every slug. We hold 3 isolvedhire
tenants, so this is near-pure net-new. Fetch cost: **1 request**.

### jazzhr — liveness-truth

The Google-feed XML lists `https://{slug}.applytojob.com/apply/…` job
URLs for every board with a live posting *today*. We hold ~8,273 jazzhr
tenants from CDX but only ~4,302 are live; the rest are `dead` /
`transient_failure`. The sitemap therefore is a **liveness-truth**
source: any slug present in it is asserted live now, so a slug we have
marked `dead`/`transient_failure` is resurrected for re-probe, and any
slug not present is left as-is (the sitemap is not exhaustive of *dead*
boards, so absence is not proof of death — the reprobe pass owns death).
The feed is paginated `xml/0..4`; the backend fetches all 5.
Fetch cost: **5 requests**.

### hiringthing — WEAK (descend-bounded)

The index keys children by a numeric `cid` (`cid_{NNNNNNNN}_sitemap.xml.gz`),
not the subdomain slug our connector identifies tenants by. The slug *is*
recoverable — a child sitemap's `<loc>` is
`https://{slug}.hiringthing.com/job/…` (verified: `cid_00003634` →
`keplercannon.hiringthing.com`). But recovering the full ~2,891-tenant
set requires fetching **2,891 gzip children**, one GET + gunzip each.
There is no cheaper slug source in the index. hiringthing is therefore
supported but flagged **WEAK**: `descend: true`, `childIsGzip: true`,
`maxChildren` default-capped low (200) so a run samples a bounded slice
rather than fetching all 2,891. An operator raising `--max 3000` can do a
full sweep deliberately, accepting the ~2,891-request cost. This is the
only backend whose default run is a partial sample.

## Cost & scheduling

isolvedhire (1 request) and jazzhr (5 requests) are cheap enough to run
routinely. hiringthing's full sweep is ~2,891 requests and must be
operator-triggered. The CI wiring exposes `discover-sitemap` as an
**optional, operator-triggered** stage (`workflow_dispatch` input
`mode: sitemap`), running before the reprobe stage so reprobe validates
the newly-seeded `transient_failure` slugs in the same pass. It is kept
off the default nightly path — the same posture as the CDX bootstrap.

## Testing

Fixture-replay on trimmed real sitemap XML (index + a gzip child) under
`scraper/src/harvest/fixtures/`. Coverage: parser determinism
(fast-check), malformed-XML resilience (`[]` not throw), **ReDoS
resilience** (a ~1MB unclosed-`<loc>` input returns `[]` in <500ms),
children cap + truncation, per-ATS slug extraction (including a `<loc>`
that must NOT mint a slug and a **confusable-host** `<loc>` that must
NOT), the **SSRF** guards (off-host child not fetched, subdomain-of-allow
allowed, off-host redirect not followed), and the merge logic (new
appended transient, live preserved, jazzhr resurrection, idempotency).
CLI tests mirror `runDiscoverGjobsfeedCommand` (success, dry-run,
unknown-ast, unsupported-ats, `--max` notice on a non-descending source).
95/95/90 per-file floor.
