# ADR-0003: Tenant lists harvested clean-room from Common Crawl

## Status

Accepted

## Context

To scrape job postings from an Applicant Tracking System we need a list of which companies (tenants) are hosted on each ATS. Greenhouse exposes `boards-api.greenhouse.io/v1/boards/{tenant}/jobs`; we cannot enumerate that endpoint without a slug list.

Other public projects in this space publish curated tenant lists, but the licenses on those lists are restrictive (some are CC BY-NC, locking out commercial reuse). To keep the licensing posture clean and avoid attribution debt, we must source our own.

## Decision

Tenant lists are harvested from the [Common Crawl](https://commoncrawl.org/) CDX index. Per-ATS regex patterns extract slugs from URL paths captured across the four most recent crawl snapshots; the union is deduped and saved to `data/tenants/{ats}.json`.

The harvester lives at `scraper/src/harvest/cdx.ts`. Each tenant is then probed for liveness:

- Hard-dead responses (HTTP 404 / 410) drop the tenant from the active list.
- Transient failures (5xx, 429) keep the tenant for retry.
- Successful probes record the tenant as live in a `tenant_status` table.

The harvester runs **weekly** (not nightly) via `.github/workflows/weekly-harvest.yml` because the CDX index is slow and tenant churn is on a weekly time scale, not daily.

Pattern examples (see `harvest/patterns.ts` for the canonical set):

```
greenhouse:  greenhouse\.io/(?:embed/)?(?:job_app\?for=|jobs/)([a-z0-9-]+)
lever:       jobs\.lever\.co/([a-z0-9-]+)
ashby:       jobs\.ashbyhq\.com/([a-z0-9-]+)
bamboohr:    ([a-z0-9-]+)\.bamboohr\.com/(?:careers|jobs)
workday:     ([a-z0-9-]+)\.wd[0-9]+\.myworkdayjobs\.com
icims:       careers-([a-z0-9-]+)\.icims\.com
```

## Consequences

### Positive

- License-clean: the published dataset can be CC BY-SA without attribution to any other open dataset.
- Reproducible: anyone can rerun the harvester and verify our tenant lists from scratch.
- Resilient to upstream churn: we are not coupled to any other project's release cadence.
- Coverage is large by default (~46k tenants across the six ATSes) without manual curation.

### Neutral

- The harvester is read-only against Common Crawl — no rate-limit etiquette concerns specific to CC.
- Slug formats are regex-extracted; a small number of false positives are possible and filtered by the liveness probe.

### Negative

- Common Crawl is not real-time. New tenants take up to a month to appear in CDX, depending on crawl cadence.
- The harvester is the slowest workflow (~30 minutes for a full sweep). Hence the weekly cadence.
- Some tenants (notably session-locked Workday installs) require JavaScript-rendered slug discovery; addressed in a later phase via a separate driver.

## Alternatives considered

- **Reuse a third-party tenant list** — fastest time-to-data, but inherits the upstream license and creates an attribution dependency we explicitly want to avoid. Locks out commercial reuse.
- **Manual curation only** — small, high-signal, but caps coverage at hundreds rather than tens of thousands of tenants.
- **Live web search per query** — high latency, fragile against bot detection, no offline behavior.
