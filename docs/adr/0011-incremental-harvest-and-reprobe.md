# ADR-0011: Incremental harvest and decoupled re-probe

## Status

Accepted

## Context

The weekly harvest currently re-fetches the latest 40 CC-MAIN snapshots and
re-probes every tenant from scratch on every run. CC-MAIN snapshots are
immutable once published, so 39 of the 40 snapshots are guaranteed-identical
work week over week. The harvest also conflates two cadences: discovery
(slug appears in CC) and liveness (tenant API responds). The first is
write-once per snapshot; the second changes on its own schedule.

Combined, this drives ~720 runner-minutes/week and IP-rate-limits us
out of `index.commoncrawl.org` after the largest 4 ATSes (run 25193840474:
bamboohr's 24-minute crawl exhausted the quota; subsequent ATSes failed
at CLI startup). The matrix refactor (ADR-tracked elsewhere) hides the
wallclock pain by parallelizing across runners but doubles total compute.

## Decision

Split the harvest into three cadences, each driven by data that actually
changes at that cadence:

1. **One-time historical bootstrap (local, manual).** Walk every
   CC-MAIN snapshot from 2008 forward with `--skip-probe`. Persist the
   per-ATS slug set into `data/tenants/{ats}.json` and record processed
   snapshot ids in `data/harvest-state/{ats}.json`.

2. **Weekly incremental discovery (CI, cheap).** New CLI flag
   `--incremental` reads `data/harvest-state/{ats}.json`, fetches
   `collinfo.json`, computes the diff (typically 1–2 new snapshots per
   week), processes only those, merges new slugs into the existing
   tenant list (additive — existing rows preserved), and updates the
   state file. No probing happens here.

3. **Weekly liveness re-probe (CI, separate job).** New CLI command
   `bun run reprobe --ats <id> --max-age-days <n> --batch-size <m>`
   selects tenants whose `last_probed_at` is older than `n` days,
   probes them in batches of `m`, and updates their `status` and
   `last_probed_at` in place. New tenants from incremental discovery
   start at `transient_failure` and are picked up by the next reprobe
   pass automatically.

Schema additions:

- `Tenant.first_seen_at`: ISO-UTC, set at discovery time, immutable.
- `data/harvest-state/{ats}.json`: per-ATS state file with shape
  ```
  {
    "schema_version": "1.0.0",
    "ats": "<id>",
    "snapshots_processed": ["2008-30", ..., "2026-04"],
    "tenant_count": <n>,
    "last_updated_at": "<iso>"
  }
  ```
  One file per ATS to avoid matrix-job write contention.

Tenant file is regenerated as a sorted-by-slug array on every harvest
write, so diffs in git stay readable.

## Consequences

### Positive

- Steady-state runner cost drops from ~720 min/week to ~30–60 min/week
  (incremental discovery is trivial; reprobe is bounded by batch-size).
- Eliminates the IP-rate-limit cliff because each weekly run hits CC for
  ~24 snapshots total instead of 960.
- Historical coverage extends from 4 years to 18+ years in one bootstrap
  pass, capturing tenants whose only public link is in pre-2022 crawls.
- Discovery and liveness become independently tunable — a flaky ATS can
  get reprobed daily while a stable one stays weekly.
- Tenant `first_seen_at` becomes a real signal (when did this slug
  first appear in a public crawl?) usable for sort order, freshness
  filters, and audit trails.

### Neutral

- Tenant files become append-mostly. Slugs that disappear from CC are
  not deleted — they ride out as `dead` until manually purged or an
  archival GC step is added.
- Bootstrap is a manual local step (4–6 hours wallclock), not part of
  CI. Documented in `specs/harvest-incremental.md`.

### Negative

- Schema migration: existing `data/tenants/{ats}.json` rows lack
  `first_seen_at`. Migration backfills it to the harvest's `observedAt`,
  which is a reasonable upper bound but not the true first-seen.
- Slug deny-list drift: if `harvest/patterns.ts` deny rules change
  later, bootstrapped tenant lists keep the old decisions. Mitigation:
  re-running `--incremental` with a `--rederive` flag would reapply
  current rules over the historical snapshot set; deferred.
- State file is now load-bearing. Corruption or accidental deletion
  forces a full re-bootstrap.

## Alternatives considered

- **Wider snapshot window every run (40 → 80 → 120).** Doubles runner
  cost without solving the underlying redundancy. Rejected.
- **Separate "fresh" and "deep" cadences (e.g. weekly latest-4, monthly
  latest-40).** Half-measure; still does redundant work and complicates
  the mental model. Rejected.
- **Probe-on-discovery only (no re-probe).** Drops the liveness
  signal's freshness over time — a tenant that died 6 months ago would
  still be `live`. Rejected.
- **Full-fat passive DNS / Certificate Transparency integration.**
  Empirically tested in scoping (see scratch notes); free tools cap
  too low to be useful, paid tools are ~$50–500/mo with marginal lift
  over CC. Rejected for the current scope.
