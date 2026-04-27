# Spec: Observability

**Version**: 1.0.0

The observability surface consists of three pure modules and one CLI subcommand
that consumes them. The modules live under `scraper/src/observability/` and
operate over the existing `Manifest`, `ScrapeOutput`, and `Tenant` shapes — no
new persistent state.

## Drift detector

`detectDrift(previous, current, thresholds?)` compares two `Manifest` records
and returns a list of `DriftFinding` objects. Findings are categorized by
`severity`: `info | warn | error`.

### Codes

| Code | Severity | Trigger |
|---|---|---|
| `first-build` | info | `previous === null` |
| `schema-version-changed` | warn | `previous.schema_version !== current.schema_version` |
| `total-rows-drop` | warn / error | `total_rows` decreased by ≥ `totalRowsDropFractionWarn` / `…Error` |
| `ats-count-zeroed` | error | `previous.ats_counts[ats] > 0 && current.ats_counts[ats] === 0` |
| `ats-drop:{ats}` | warn / error | per-ATS `total_rows` decreased by ≥ `atsRowsDropFractionWarn` / `…Error` |
| `tenants-live-drop` | warn / error | `tenants_live` decreased by ≥ `tenantsLiveDropFractionWarn` / `…Error` |

### Default thresholds

```typescript
{
  totalRowsDropFractionWarn: 0.10,
  totalRowsDropFractionError: 0.25,
  atsRowsDropFractionWarn: 0.20,
  atsRowsDropFractionError: 0.50,
  tenantsLiveDropFractionWarn: 0.10,
  tenantsLiveDropFractionError: 0.25,
}
```

### Boundary semantics

- Comparisons are inclusive (`drop >= threshold`). A 0.50 drop classifies as
  `error`; a 0.49 drop classifies as `warn`.
- A previous count of `0` does not emit a finding for that field, regardless
  of the current value. This covers both the "field came online" case
  (`prev=0, curr=N`) and the "still zero" case (`prev=0, curr=0`).
- Increases never emit a finding. Drift is one-sided (drops only).

## Dead-tenant tracker

`detectDeadTenants(history, consecutiveThreshold)` accepts a list of
`TenantSnapshot` records (each `{observed_at, tenants}`) and returns
`DeadTenantAlert[]` for tenants that have been `dead` in **every** snapshot
of the trailing window of size `consecutiveThreshold`.

### Window contract

- The window is the **last** `consecutiveThreshold` snapshots, sorted by
  `observed_at` ascending.
- A tenant must appear with `status === "dead"` in the **first** snapshot of
  the window. A tenant that appears as dead only in a later snapshot is not
  alerted on this run, even if it remains dead from then on. Operators get an
  alert on the next run that satisfies the window.
- A flicker to `live` (or to `transient_failure`) anywhere in the window
  removes the tenant from the alert set. The window is re-evaluated from
  scratch every run.
- Alerts are sorted by `(ats, slug)` using the canonical `ATS_IDS` order, then
  ASCII-lexicographic slug, for deterministic CI output.

## Run-report

`renderRunReport(input)` returns a Markdown string with these sections, in
order:

1. **Header** — `# openroles run report — {short_sha}` plus build timestamp,
   schema version, and database filename.
2. **Totals** — jobs, tenants (total / live), aggregated request counts
   across the supplied scrape outputs, total bytes received, and aggregated
   wall time.
3. **Per-ATS counts** — Markdown table of `ats_counts`, in the canonical
   `ATS_IDS` order.
4. **Drift** — bulleted list of `[{severity}] code — message` entries, or
   `_No drift findings._`.
5. **Dead tenants** — Markdown table of `(ats, slug, consecutive_dead,
   first_seen_dead_at, last_seen_dead_at)`, or
   `_No tenants exceed the consecutive-dead threshold._`.

### Output stability

- Numbers use `Intl.NumberFormat("en-US")` so output is locale-stable.
- Durations format as `{ms}ms` below 1 second, `{s.x}s` below 60 seconds, and
  `{m}m {s}s` thereafter. Negative or non-finite durations render as `0s`.
- The output ends with exactly one trailing newline.
- Severity prefixes (`[ERROR]`, `[WARN]`, `[info]`) use intentional
  case asymmetry to draw the eye toward errors first; the test suite pins
  these strings.
- All interpolated values come from schema-validated sources (`Manifest`,
  `Tenant`, `ScrapeOutput`) whose constraints rule out Markdown
  metacharacters. `db_filename` is constrained to `jobs.{short_sha}.sqlite[.gz]`
  to keep the inline-code span well-formed.

## CLI `report` subcommand

```
openroles-scrape report [options]

  --input <dir>             Directory with manifest.json + per-ATS scrape outputs (default: ./data)
  --previous-manifest <p>   Path to previous build's manifest.json for drift detection
  --tenants-history <p>     Path to a JSON array of TenantSnapshot for dead-tenant analysis
  --consecutive-dead <n>    Window size for dead-tenant analysis (default: 3)
  --output <path>           Path to write the Markdown report (default: stdout)
  --fail-on <severity>      Exit non-zero when drift severity reaches this level
                            (info | warn | error; default: error)
```

### Exit codes

- `0` — report rendered successfully and either drift is empty or severity is
  below `--fail-on`.
- `1` — drift findings exist and observed severity meets or exceeds
  `--fail-on`.
- `2` — invalid arguments or upstream parse error.

`--fail-on` only fires when `drift.length > 0`. An empty drift list is
explicitly never a failure regardless of the level chosen, so `--fail-on=info`
is safe to pin in CI without producing a false alarm on a stable build.

### File-discovery behavior

`--input` directory entries are filtered to JSON files, with `manifest.json`
and any `tenants*` entries (e.g. `tenants/`, `tenants-history.json`) excluded.
The remaining JSON files are validated through `ScrapeOutputSchema`; entries
that fail validation are silently skipped — they may be sibling artifacts
like `previous-manifest.json` written into the same directory.
