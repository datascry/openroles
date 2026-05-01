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

Run once locally — the CI weekly-harvest assumes the state file exists
and a tenant list is already populated.

```sh
# 1. Discover every slug visible in CC-MAIN snapshots from 2008 onward.
#    This is slow (4–6 hours wallclock for 24 ATSes; CC-MAIN has ~120
#    snapshots back to 2008). Run from a machine with a stable
#    connection. --skip-probe defers liveness for the second pass below.
ATS_LIST="greenhouse lever ashby bamboohr workday icims recruitee \
breezy personio workable teamtailor smartrecruiters csod taleo \
ultipro jobvite zohorecruit talentlyft pinpointhq applicantpro \
applicantstack homerun factorial eightfold"

for ats in $ATS_LIST; do
  echo "=== bootstrap $ats ==="
  bun run harvest \
    --ats "$ats" \
    --snapshots-since 2008 \
    --skip-probe \
    --contact-url https://github.com/datascry/openroles
done

# 2. Probe every slug for liveness. --max-age-days=0 forces a probe
#    regardless of recency; --batch-size=100000 raises the per-run cap
#    so the entire just-bootstrapped corpus is covered.
for ats in $ATS_LIST; do
  echo "=== probe $ats ==="
  bun run reprobe \
    --ats "$ats" \
    --max-age-days 0 \
    --batch-size 100000 \
    --contact-url https://github.com/datascry/openroles
done

# 3. Commit the bootstrap data.
git add data/tenants/ data/harvest-state/
git commit -m "chore(harvest): bootstrap historical tenant lists from CC-MAIN since 2008"
git push origin main
```

After this commits, the weekly-harvest CI takes over. Each weekly run
processes only the 1–2 new snapshots since last week (~30s of CDX
work per ATS) and reprobes the ~5,000 oldest tenants per ATS (15-min
cap per matrix leg).

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
