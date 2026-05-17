# ADR-0016: Vendor-agnostic harvesters, CC columnar enumeration, and the cross-ATS dedup guard

## Status

Accepted

## Context

ADR-0010's phase plan states that decisions made after Phase 13 land as
ADRs. Three adapter additions and two supporting mechanisms shipped
after that line without an ADR; this record captures the decision trail
retroactively.

The CDX-discoverable multi-tenant model (ADR-0003) assumes a tenant is a
slug derivable from a canonical host pattern in Common Crawl
(`{slug}.greenhouse.io`, `{slug}.bamboohr.com`, …). A growing slice of
target brands does not fit that model:

- Brands on **proprietary careers stacks** that nonetheless publish
  `schema.org/JobPosting` JSON-LD for Google-for-Jobs SEO (TalentBrew
  family — Lockheed Martin, Spectrum).
- **IBM Kenexa / BrassRing** — multi-tenant but every tenant shares one
  host (`sjobs.brassring.com`); the tenant is a `(partnerid, siteid)`
  pair behind a CSRF + cookie handshake, not a slug in the URL.
- **SuccessFactors-backed brands** (SAP, ExxonMobil, Halliburton,
  Cintas, …) whose own `careersection` API is `robots.txt: Disallow: /`
  but who expose an open Google-for-Jobs **RSS feed** for indexing.

For all three, the tenant identity is an operator-supplied pointer, not
a CDX-enumerable slug. Adding them naively also created a second
problem: a brand reachable through two adapters (e.g. Boston Scientific
live under `eightfold` *and* discoverable as a `gjobsfeed` feed)
double-counts, because `build-db` de-dupes only by exact `Job.url`.

## Decision

**1. A class of vendor-agnostic / hand-seeded harvesters.** Three new
`ATSId`s, each identifying a tenant by a mandatory `metadata` pointer
rather than a CDX slug; the dispatcher marks a tenant `dead` if the
pointer is absent (mirrors the workday/ultipro composite-metadata
convention):

- `jsonld` (`metadata.sitemap_url`) — walk a sitemap, extract
  `schema.org/JobPosting` JSON-LD per linked page. Shares parsing core
  with iCIMS. Schema 2.0.0 → 3.0.0.
- `brassring` (`metadata.partnerid` + `metadata.siteid`) — two-step
  GET-home (capture `__RequestVerificationToken` + Set-Cookie) then
  POST `…/Search/Ajax/PowerSearchJobs`. Schema 3.0.0 → 4.0.0.
- `gjobsfeed` (`metadata.feed_url`) — one GET of a brand's RSS 2.0
  Google-for-Jobs feed (`xmlns:g="http://base.google.com/ns/1.0"`);
  every `<item>` is a complete posting. Schema 4.0.0 → 5.0.0. See
  [specs/gjobsfeed-adapter.md](../../specs/gjobsfeed-adapter.md).

Each adds one `ATS_IDS` entry — a **major** schema bump every time,
because `ATSCountsSchema` is `.strict()` (see
[specs/data-schema.md](../../specs/data-schema.md)). Each registers a
**no-op CDX harvest pattern** so the `HARVEST_ATS_IDS == ATS_IDS`
invariant holds without minting spurious tenants; seeds are
operator-curated and promoted from `transient_failure` → `live` by the
weekly reprobe pass. The SSRF guard (`isSafeFetchHost`: https-only, no
IP literals / loopback / RFC1918 / `.local` / `.internal` / metadata
IPs) is applied at both the probe builder and the scrape boundary.

**2. Common Crawl columnar-index enumeration** (`enumerate-gjobsfeed-hosts`).
CDX indexes URLs, not response bodies, so it cannot *confirm* a feed
(the `base.google.com/ns/1.0` signature is in the body) — but the CC
**columnar index** (Parquet on S3, queried via the DuckDB CLI) can
*enumerate* every crawled `/sitemap.xml` on a career-prefixed host
web-wide. Enumeration grows `data/gjobsfeed-candidates.json`; the
existing `discover-gjobsfeed` probe + dedup guard confirm and gate.
The query is **operator-run only** (requires explicit
`--snapshots CC-MAIN-YYYY-NN` and the `duckdb` binary; hard exit 2
otherwise) — a few-hundred-GB scan (~$1–3 via Athena) that must never
be cron-triggered. See
[specs/gjobsfeed-cc-enumeration.md](../../specs/gjobsfeed-cc-enumeration.md).

**3. Cross-ATS dedup guard** (`scraper/src/harvest/cross-ats-dedup.ts`).
`collectLiveSlugsExcluding` (pure) + `liveSlugsExcluding` (fs) surface
the set of slugs already `status=live` under any *other* ATS. The
discover/seed path skips them — the single chokepoint preventing the
same role double-counting under two adapters with two URLs.

## Consequences

### Positive

- Unlocks brand classes the CDX model structurally cannot reach:
  proprietary-stack JSON-LD, the shared-host BrassRing tenancy, and
  the robots-blocked-but-feed-publishing SuccessFactors population
  (gjobsfeed live at ~6,800 roles across 12 tenants).
- The dedup guard is one tested chokepoint; cross-ATS double-counting
  is structurally prevented rather than cleaned up after the fact.
- CC columnar enumeration makes `gjobsfeed` discovery systematic and
  repeatable instead of hand-typed, without putting a paid heavyweight
  scan in CI.
- Each adapter is self-contained and follows the established
  parse/scrape/fixture-replay/property-test shape; failure of one
  doesn't cascade.

### Neutral

- `ATS_IDS` widened 29 → 32 across three major schema bumps
  (3.0.0/4.0.0/5.0.0). Manifest reads of older databases stay clean
  because `ats_counts` auto-defaults missing keys to 0.
- These adapters do not participate in CDX discover the way
  multi-tenant ATSes do; their harvest pattern is a deliberate no-op
  and seeds are operator-driven. The weekly **reprobe** matrix still
  covers them (promotion + liveness).
- The Google-for-Jobs feed (Radancy/TalentBrew) is served at the
  counterintuitive `/sitemap.xml` path for these brands — documented
  in the spec and seed comments so it is not "corrected" away.

### Negative

- The feed-publishing niche is small: even across the ~280 largest US
  employers the `gjobsfeed`-eligible hit rate is ~4–5%. The CC
  enumeration scales discovery of this niche but does not enlarge it;
  total `gjobsfeed` coverage will stay in the tens-to-low-hundreds of
  brands, not thousands.
- `enumerate-gjobsfeed-hosts` depends on an external tool (`duckdb`)
  and incurs real S3 scan cost; it is operator-run and quarterly by
  intent, which means candidate freshness is bounded by operator
  cadence, not the daily pipeline.
- The dedup guard keys on a slug being `live` elsewhere; a slug that
  is `transient_failure` under another ATS is *not* skipped. This is
  intentional (don't suppress a feed because a flaky foreign tenant
  is temporarily down) but means a brief double-count window is
  possible if a foreign tenant recovers after a gjobsfeed seed lands.
- `applejobs` / `tiktokcareers` / `metacareers` / `successfactors`
  remain zero-yield (auth-gated or robots-blocked); the
  SuccessFactors *brands* are recovered via `gjobsfeed`, but those
  four adapters stay in the matrix as documented dead weight pending
  a policy change.

## Alternatives considered

- **Force the new tenants into the CDX-discoverable model** — rejected:
  their identity is not a slug in a canonical host; CDX cannot
  enumerate `(partnerid, siteid)` pairs or per-brand feed URLs.
- **Full Common Crawl WARC body scan to confirm feeds directly** —
  rejected: the signature is in the body, so confirmation would mean
  scanning WARC payloads (orders of magnitude more data than the
  columnar URL index). Enumerate cheaply via the columnar index, then
  confirm with a 2 KB probe.
- **Run the CC enumeration inside weekly CI** — rejected: a
  few-hundred-GB Parquet scan per run is the wrong cost for a
  population that changes slowly; operator-run, gated behind an
  explicit flag + the duckdb binary.
- **Post-hoc cross-ATS dedup in build-db** — rejected in favor of
  seed-time prevention: build-db only sees `Job.url`, so the same
  role under two adapters has two URLs and two ids; collapsing them
  there would need a fuzzy title/company match. Skipping at seed time
  is exact and cheap.
- **A headless-browser harvester for the robots-blocked APIs**
  (SuccessFactors, Apple, TikTok, Meta) — rejected for now: the
  open RSS feed is the policy-compliant source for the SuccessFactors
  brands; the others stay deferred (consistent with ADR-0015's
  "write that ADR when it becomes necessary").
