# gjobsfeed candidate enumeration via the Common Crawl columnar index

## Why

`discover-gjobsfeed` probes a candidate list (`data/gjobsfeed-candidates.json`)
for the Google-for-Jobs RSS signature. Hand-curating that list caps
coverage at whatever an operator can type (~tens of brands). The
scalable source is the **Common Crawl columnar index**: it records
every URL CC has crawled, including the `/sitemap.xml` of career
subdomains, so it can *enumerate candidate hosts* across the whole web
in one query. CC cannot *confirm* the feed (the
`xmlns:g="http://base.google.com/ns/1.0"` signature is in the response
body, not the URL) — that stays the probe step's job. Enumeration +
probe + the cross-ATS dedup guard compose into a scalable pipeline.

## The query (validated against CC's official schema)

CC publishes the columnar index as Parquet at
`s3://commoncrawl/cc-index/table/cc-main/warc/`, partitioned by
`crawl` and `subset`. Schema (from CC's official Athena DDL,
`commoncrawl/cc-index-table` `cc-index-create-table-flat.sql`):
`url_surtkey, url_host_name, url_host_name_reversed, url_path,
fetch_status, content_mime_type, content_mime_detected, crawl,
subset`.

```sql
SELECT DISTINCT url_host_name
FROM read_parquet(
  's3://commoncrawl/cc-index/table/cc-main/warc/crawl={CRAWL}/subset=warc/*.parquet'
)
WHERE url_path = '/sitemap.xml'
  AND fetch_status = 200
  AND regexp_matches(url_host_name, '^(jobs|careers|job|career|recruiting|talent)\.')
```

`{CRAWL}` is a CC-MAIN id (e.g. `CC-MAIN-2026-17`, latest from
`https://index.commoncrawl.org/collinfo.json`). The
career-subdomain prefix filter keeps the result to plausible careers
hosts; the probe + dedup guard are the real gates, so a loose prefix
is fine (false positives cost one HEADless 2 KB GET each).

## Cost & cadence — operator-run, NOT weekly CI

The `jobs.` subdomain is **not** a SURT prefix (SURT reverses the
registrable domain first: `com,sap,jobs)/sitemap.xml`), so the query
cannot row-group-prune by `url_surtkey` and must scan the
`url_host_name` / `url_path` / `fetch_status` columns for the whole
crawl — on the order of a few hundred GB of Parquet (column-projected).
Via Athena that is roughly **$1–3 per run** ($5/TB scanned); via the
DuckDB CLI with `httpfs` it is a large streamed download.

This is therefore a **deliberate, occasional, operator-run** step
(quarterly is plenty — the feed-publishing population changes slowly),
**not** part of `weekly-harvest.yml`. Running a multi-hundred-GB scan
on every CI tick would be wrong. The command refuses to run unless
`duckdb` is on PATH and the operator passed `--snapshots` explicitly (no
silent default that could be cron-triggered).

## Pipeline

```
enumerate-gjobsfeed-hosts --snapshots CC-MAIN-2026-17
  └─ duckdb runs the query above over s3 (httpfs, anonymous)
  └─ each url_host_name → candidate { slug, display_name, hosts:[host] }
        slug = deriveSlug(host): strip a leading careers-prefix label,
               then the registrable label before the public suffix
               (handles .com and the common 2-label suffixes
               .co.uk/.com.au/.co.jp; oddities are operator-reviewed
               and the probe/guard still gate them)
  └─ merge into data/gjobsfeed-candidates.json, deduped by slug,
        existing entries preserved (idempotent, stable sort)

discover-gjobsfeed   (unchanged, existing command)
  └─ probes each candidate host for the RSS signature
  └─ skips slugs already live under another ATS (dedup guard)
  └─ seeds matches into data/tenants/gjobsfeed.json
```

Enumeration only *grows the candidate list*; it never writes tenant
records or touches the corpus directly. The probe step remains the
single place a feed is confirmed and the dedup guard the single place
cross-ATS collisions are prevented.

## Testability

The heavyweight S3 scan is the operator's call and is not exercised in
CI. The pure, deterministic surface IS unit-tested at the 95/95/90
floor:

- `deriveSlug(host)` — prefix stripping, public-suffix handling,
  rejection of malformed/empty/IP hosts.
- `parseDuckdbHostRows(stdout)` — tolerant parse of the CLI output
  (header, quoting, blank lines, CRLF).
- `mergeCandidates(existing, discovered)` — dedupe by slug, preserve
  existing, stable sort, drop entries whose slug/host fail validation.

The `duckdb` invocation is a thin shell-out with the validated SQL;
absence of `duckdb` or a missing `--snapshots` is a hard, actionable error
(exit 2), never a silent no-op.
