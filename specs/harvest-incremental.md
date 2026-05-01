# Harvest — incremental discovery + decoupled reprobe

Status: accepted (ADR-0011)

This spec describes how to bootstrap, run, and reason about the
incremental harvest pipeline. The split is:

- **Discovery** — find slugs in CC-MAIN snapshots, write them into
  `data/tenants/{ats}.json`. Cumulative across runs; old snapshots are
  never re-fetched once recorded.
- **Reprobe** — periodically test slug liveness with an HTTP probe,
  update `status` and `last_probed_at` in place.

State: `data/harvest-state/{ats}.json` records which CC-MAIN snapshot
ids have already been processed for that ATS. The CLI uses it to
compute the diff against `collinfo.json` on each `--incremental` run.

## One-time bootstrap

**Bootstrap runs locally, not in CI.** Common Crawl's index server
imposes a sticky per-IP rate-limit that's already bitten the
40-snapshot weekly harvest (run 25193840474: bamboohr's 24-minute
crawl exhausted the runner's quota and every subsequent ATS failed at
CLI startup). A 120-snapshot pull from CI would hit the same cliff
~3× harder; even the matrix-per-ATS layout shares GitHub's IP pool
and the throttle is sticky enough to compound.

A laptop on a residential connection routes outbound through a
different IP, and pacing is under your control — the existing
`interPageSleepMs=250` plus the CLI's adaptive backoff handles CC's
throttle window without nuking the whole sweep.

### CDX backend: HTTP vs S3-direct

Two backends exist; pick via the `OPENROLES_CC_BACKEND` environment
variable.

- **`http`** (default) — paginated GET against
  `index.commoncrawl.org/CC-MAIN-{id}-index?url=...`. Subject to the
  per-IP throttle described above. Required for ATSes whose canonical
  tenant URLs are robots-blocked (lever's `jobs.lever.co/*`) or where
  Common Crawl simply hasn't indexed the host (talentlyft).

- **`s3`** — anonymous range requests against
  `data.commoncrawl.org/cc-index/collections/CC-MAIN-{id}/indexes/`,
  reading the same CDX data via cluster.idx + per-block range fetches.
  No per-IP throttle (CloudFront edge, S3-rate-limited per AWS account).
  One cluster.idx download per collection (~100 MB) is cached at
  `<output-dir>/harvest-state/cluster-idx/<id>.idx` and reused across
  every ATS that targets the same collection — the difference between
  minutes and many GB of repeated download for a 22-ATS × 120-collection
  bootstrap.

  Per the audit (recorded in this spec's history), 22 of 24 ATSes have
  rich tenant URLs in CDX and benefit from S3 directly. The two
  outliers (lever, talentlyft) need an alternate discovery signal and
  should keep using the existing tenant lists; S3 doesn't help them.

  Recommended bootstrap invocation:

  ```sh
  OPENROLES_CC_BACKEND=s3 bun run harvest \
    --ats greenhouse \
    --snapshots-since 2008 \
    --skip-probe \
    --contact-url https://your.contact.example
  ```

  The S3 backend honors a `maxBlocksPerSnapshot` cap (default 200) so a
  too-broad SURT prefix can't fan out unboundedly. Per-block failures
  (network blip, gunzip on a corrupted slice) are recovered from with
  partial results — the snapshot is only counted as errored when every
  attempted block failed. Adaptive inter-snapshot backoff still applies
  on consecutive failures, same shape as the HTTP path.

### Procedure

```sh
ATS_LIST="greenhouse lever ashby bamboohr workday icims recruitee \
breezy personio workable teamtailor smartrecruiters csod taleo \
ultipro jobvite zohorecruit talentlyft pinpointhq applicantpro \
applicantstack homerun factorial eightfold"

# Stage 1 — discovery. Walks every CC-MAIN snapshot from 2008 forward.
# Sequential per-ATS keeps a single connection-pool open and lets CC's
# throttle window apply to one ATS at a time. Slow but resilient: 4-6
# hours wallclock for 24 ATSes. Run from a machine that won't sleep.
for ats in $ATS_LIST; do
  echo "=== bootstrap discover $ats ==="
  bun run harvest \
    --ats "$ats" \
    --snapshots-since 2008 \
    --skip-probe \
    --contact-url https://github.com/datascry/openroles
done

# Stage 2 — liveness probe across every just-discovered slug.
# --max-age-days=0 forces probes regardless of last_probed_at;
# --batch-size=100000 raises the per-run cap so the whole corpus is
# covered. Probe traffic goes to each ATS's public API directly, not
# through CC, so this stage is bounded by per-ATS rate limits which
# the CLI already retries with backoff.
for ats in $ATS_LIST; do
  echo "=== bootstrap probe $ats ==="
  bun run reprobe \
    --ats "$ats" \
    --max-age-days 0 \
    --batch-size 100000 \
    --contact-url https://github.com/datascry/openroles
done

# Stage 3 — commit.
git add data/tenants/ data/harvest-state/
git commit -m "chore(harvest): bootstrap historical tenant lists from CC-MAIN since 2008"
git push origin main
```

After this commits, the weekly-harvest CI takes over. Each weekly run
processes only the 1–2 new snapshots since last week (~30s of CDX
work per ATS) and reprobes the ~5,000 oldest tenants per ATS — well
inside CC's per-IP budget.

### `mode=bootstrap` workflow_dispatch (escape hatch only)

The `weekly-harvest.yml` workflow does expose `mode=bootstrap` via
manual dispatch, but it's an escape hatch for narrow cases (one ATS
needs re-bootstrapping, or you're testing the workflow in isolation).
Triggering it across all 24 ATSes from a fresh CI runner pool is the
exact failure mode this spec exists to avoid.

If you do use `mode=bootstrap`, set `bootstrap_since_year` to a recent
year (e.g. 2024) to keep the per-ATS work small enough to finish
inside CC's throttle window.

## Weekly cadence (CI)

Two stages, each as a 24-leg matrix:

1. **discover** — runs `bun run harvest --ats <id> --incremental
   --skip-probe`. CLI resolves `collinfo.json`, computes the diff
   against `data/harvest-state/{ats}.json`, processes only new
   snapshots, merges new slugs into the existing tenant file (additive),
   updates the state file. New slugs land at `transient_failure` until
   the next reprobe pass promotes them.

2. **reprobe** — runs `bun run reprobe --ats <id>
   --max-age-days 7 --batch-size 5000`. Picks tenants whose
   `last_probed_at` is older than 7 days, oldest-first, up to the batch
   cap. HTTP-probes each, updates status. Skips ATSes whose tenant
   file is missing.

A final **commit** job downloads all per-ATS artifacts and rebase-pushes
the change to main.

`workflow_dispatch` exposes a `mode` choice (`both`, `discover-only`,
`reprobe-only`) for surgical runs. `max_age_days` and `batch_size` are
also overridable per dispatch.

## State file shape

```json
{
  "schema_version": "1.0.0",
  "ats": "greenhouse",
  "snapshots_processed": ["2008-30", "2008-39", ..., "2026-13"],
  "tenant_count": 18421,
  "last_updated_at": "2026-04-30T00:00:00Z"
}
```

One file per ATS at `data/harvest-state/{ats}.json` so matrix-job legs
never write the same path. `snapshots_processed` is sorted ascending
for deterministic diffs.

## Tenant file invariants

- Sorted by slug (ascending) on every write.
- `first_seen_at` set once at discovery, never overwritten.
- `last_probed_at` updated only by reprobe; harvest leaves it alone for
  existing tenants.
- `status` updated only by reprobe; harvest leaves it alone for
  existing tenants.
- `metadata` may be backfilled by harvest if a later snapshot surfaces
  metadata an existing tenant lacked (e.g. workday `host`/`site`).
- Tenants that disappear from CC are **not deleted** — they ride out
  with their last known status. Garbage collection is out of scope for
  this iteration.

## Failure modes

- **State file missing** for an ATS in CI → discover job emits a
  `::notice::` and exits 0. Run the local bootstrap to seed.
- **State file malformed JSON** → CLI throws. The check is strict on
  purpose; a corrupt state file would silently re-do years of work.
- **State file `ats` mismatch** (e.g. someone copied
  `greenhouse.json` to `lever.json`) → CLI throws.
- **collinfo.json unreachable** → CLI returns 2 with `harvest: failed
  to resolve CC-MAIN snapshots`. Same retry/backoff as the existing
  HTTP client.
- **Probe rate-limit during reprobe** → individual probes return
  `transient_failure`; the tenant keeps its prior `last_probed_at` so
  it stays at the front of the next reprobe queue.

## Migration from pre-incremental tenant files

The existing `data/tenants/{ats}.json` files (pre-ADR-0011) lack
`first_seen_at`. The schema marks it optional during the migration
window, and the CLI backfills it to the harvest's `observedAt` on the
first re-write. After one full weekly cycle the field is set on every
row.

The bootstrap procedure above is the recommended migration path — it
replaces the pre-incremental tenant files with a comprehensive,
state-tracked set.
