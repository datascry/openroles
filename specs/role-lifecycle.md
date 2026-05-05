# Spec: Role Lifecycle

**Version**: 1.0.0

How an open role enters, persists in, and leaves the openroles database. This is a behavior contract for the build pipeline (`bun run scrape` → `bun run build-db`) and the rendering surface (FilterTable). Any change to the lifecycle model — TTL window, stale-state semantics, schema fields — MUST land as a new version of this spec.

## Goals

1. **A daily upstream-API outage MUST NOT erase a tenant's catalogue.** Today's transient failure should not look indistinguishable from "the company removed every role overnight."
2. **Genuinely-removed roles SHOULD disappear quickly.** A role pulled from an ATS should not linger as a ghost for weeks.
3. **Users MUST be able to tell** when a role is "current as of today" versus "last verified some time ago." The two states need distinct visual surface.
4. **`first_seen_at` and `last_seen_at` MUST be honest.** The schema's stated semantics — when our crawl first / last observed the role — must match the implementation.

The current daily-rebuild model (each day's DB is built from scratch using only that day's scrape outputs) satisfies #2 perfectly but fails #1 (a 5xx outage drops the tenant) and #4 (`first_seen_at` is overwritten every build).

## Lifecycle states

A row in `jobs.{sha}.sqlite` is in exactly one of these states on any given build:

| State | `is_stale` | `last_seen_at` | Meaning |
|---|---|---|---|
| **Fresh** | `0` | today's `observedAt` | Successfully scraped today. The ATS confirmed the role exists. |
| **Stale** | `1` | yesterday or older | Carried forward from a previous build; today's scrape didn't include it (tenant API error or whole-tenant transient_failure). |
| (Dropped) | n/a | n/a | Not in the DB. Either never existed, or stale longer than the TTL. |

The `is_stale` column is a SQLite `INTEGER NOT NULL DEFAULT 0` (zod `boolean`). It is computed at build time and is not a persisted product of upstream data.

## TTL

A stale role is dropped from the DB when:

```
today.observedAt − previous.last_seen_at  ≥  STALE_TTL_DAYS
```

Default: **`STALE_TTL_DAYS = 3`**. Configurable via `--stale-ttl-days` on `build-db` (env: `STALE_TTL_DAYS`). Lower bound: 1 (drop next day). Upper bound: 14.

The window is rounded up to whole days against UTC midnight, not the literal scrape time, so a role first seen at 23:59 UTC and then absent for 3 builds drops on day 4 not day 3.5.

## Build pipeline (post-Phase-12)

```
1. Read previous DB if --previous-db <path> is set.
   Skip cleanly if file is missing — first-ever build has nothing to merge.

2. Read today's scrape outputs (data/scrape-outputs/*.json).

3. Build the merged row set:
   for each fresh row from today:
     emit { ...row, is_stale: 0, first_seen_at: previous.first_seen_at ?? today, last_seen_at: today }
   for each previous row not in today's id set:
     if (today − previous.last_seen_at) < STALE_TTL_DAYS:
       emit { ...previous, is_stale: 1 }   // carry forward
     // else drop

4. INSERT OR REPLACE every emitted row into a fresh jobs.{new_sha}.sqlite.

5. Recompute manifest: total_rows, ats_counts, fresh_count, stale_count.
   tenants_total / tenants_live unchanged.
```

The previous-DB read is the **only** carry-forward path. There is no separate "stash" or "tombstone" table.

## `first_seen_at` semantics

After Phase 12, `first_seen_at` MUST be carried forward from the previous DB when the same `Job.id` is observed again. The first time a role is observed, both timestamps are the current build's `observedAt`. Every subsequent fresh observation:

- `last_seen_at` advances to the current `observedAt`.
- `first_seen_at` stays at the original observation.

A stale-then-fresh cycle preserves the original `first_seen_at`: a role that goes stale for 1 day and is re-observed on day 2 keeps its original `first_seen_at` from day 0.

A role that drops past TTL and re-emerges later is treated as a **new** role (new `first_seen_at`). Its `Job.id` is the same SHA — that is intentional; users keep their saved/applied/ignored state across the gap.

## Tenant-status carry-forward

A role's lifecycle state is independent of its tenant's status. In particular:

- **Tenant `live`**: roles always carry forward / drop per the TTL rule.
- **Tenant `transient_failure`**: roles carry forward as stale exactly the same way. The tenant's failure is what *causes* the staleness; the lifecycle rule does not need to special-case it.
- **Tenant `dead`**: roles carry forward as stale until the TTL drops them. There is no shorter path. (Rationale: a tenant being marked dead is itself a probe-pipeline judgement that may be wrong; relying on it to bypass TTL would amplify probe-pipeline errors into role data.)

## Manifest schema additions

Schema bumps to **1.3.0**. Two new fields:

```typescript
{
  // ... existing 1.2.0 fields ...
  fresh_count: number;     // jobs with is_stale = 0
  stale_count: number;     // jobs with is_stale = 1
  stale_ttl_days: number;  // the TTL the build was run with
}
```

`total_rows = fresh_count + stale_count`. The check is enforced in `ManifestSchema.superRefine`.

## Drift detector

[scraper/src/observability/drift.ts](../scraper/src/observability/drift.ts) gains two new findings:

- **info**: `stale_count > 0` — surface the count and per-ATS breakdown.
- **warn**: `stale_count / total_rows > 0.10` — more than 10 % of the catalogue is unverified, suggesting a widespread upstream outage rather than per-tenant transients.
- **error**: `stale_count / total_rows > 0.25` — quarter of the catalogue is stale, deploy gating should kick in.

The thresholds are tunable via the existing `--fail-on` flag.

## Filter behavior

Stale roles are returned by default when no filter is set. Three new visible affordances:

- A `STALE · {N}D` badge in each stale row's kicker line, where `{N}D` is `floor((today − last_seen_at) / 86_400_000)`.
- Row-level dimming via `opacity: 0.6` so the row reads as secondary at a glance.
- A `+ Hide unverified` filter button that adds `hideStale=1` to the URL state.

URL parameter: `hide_stale` (omitted = include stale; `1` = exclude). Round-trip-tested in [site/src/lib/filter-state.test.ts](../site/src/lib/filter-state.test.ts).

SQL: when `hide_stale` is set, the WHERE clause adds `is_stale = 0`.

## User-side state (saved / applied / ignored)

`localStorage["openroles:v1:{saved,applied,ignored}"]` continues to store `Job.id[]`. The carry-forward semantics specifically protect saved-job lookups: a role going stale does not change its `Job.id`, so a saved role's lookup still resolves until the role drops past TTL.

After TTL drop:
- Saved IDs become orphans. The current UI does not surface "this saved role is gone." A future Phase 13 may add a "Saved" sub-page that surfaces orphans.
- Applied / ignored IDs are likewise orphaned but are write-only from the user's perspective, so no UI change is required.

## Acceptance tests

The following invariants are guarded by test:

- **Property test (fast-check, [scraper/src/db/build-db.test.ts](../scraper/src/db/build-db.test.ts))**: for any random valid `(prev_db, today_outputs, ttl_days)` triple, every emitted row satisfies one of: (a) appears in `today_outputs.jobs` with `is_stale = 0`, (b) appears only in `prev_db` with `is_stale = 1` AND `today − last_seen_at < ttl_days`, (c) does not appear at all.
- **Unit test**: a role observed on day 0, missing days 1, 2, present again day 3 carries the day-0 `first_seen_at` forward.
- **Unit test**: a role missing for `STALE_TTL_DAYS` consecutive builds drops cleanly.
- **E2E**: a stale row in the fixture renders the `STALE · ND` badge, dims at `opacity: 0.6`, and is excluded when `+ Hide unverified` is toggled on.

## Rejection cases

Things this spec deliberately does not do:

- **No "filled" vs "expired" distinction.** The system can only observe presence/absence; we do not infer why a role disappeared.
- **No tombstone table for orphan saved IDs.** Orphan handling lives in the client, not in the pipeline.
- **No per-tenant TTL override.** The 3-day window applies uniformly. A future spec may revisit if specific tenants prove pathological.
- **No staleness on a freshly-observed role.** Once today's scrape includes the role, `is_stale` is `0` and the previous staleness is forgotten. A role can flip stale-fresh-stale-fresh in successive builds.

## Files

- [scraper/src/db/build-db.ts](../scraper/src/db/build-db.ts) — implements the merge.
- [scraper/src/db/schema.ts](../scraper/src/db/schema.ts) — `is_stale` column + index.
- [shared/src/schema/job.ts](../shared/src/schema/job.ts) — `is_stale` field on `Job` zod.
- [shared/src/schema/manifest.ts](../shared/src/schema/manifest.ts) — `fresh_count` / `stale_count` / `stale_ttl_days`.
- [shared/src/constants.ts](../shared/src/constants.ts) — `SCHEMA_VERSION` bumped to `1.3.0`, `STALE_TTL_DAYS_DEFAULT = 3`.
- [scraper/src/cli.ts](../scraper/src/cli.ts) — `build-db --previous-db <path> --stale-ttl-days <n>`.
- [site/src/components/FilterTable.svelte](../site/src/components/FilterTable.svelte) — `STALE` badge + `hideStale` chip.
- [site/src/lib/filter-state.ts](../site/src/lib/filter-state.ts) — `hideStale` field.
- [site/src/lib/filter-sql.ts](../site/src/lib/filter-sql.ts) — `is_stale = 0` clause.
