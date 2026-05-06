# ADR-0014: Filter UI information architecture — primary axes, no sort

## Status

Accepted

## Context

The filter sidebar accumulated seven groups during the early phases —
ATS, Level, Workplace, Posted, Min comp, Status, Personal — plus a
sort dropdown carrying eight options. After the slim-index migration
([ADR-0012](0012-static-only-deployment.md)) it became visible that:

- **Most groups didn't pull their weight for end users.** Job seekers
  filter by where they want to work and what level the role is. They
  don't filter by which hiring platform hosts the listing — that's a
  developer-facing detail. With 24 ATSes shipped and most carrying
  near-zero rows on any given day, the ATS group dominated the
  sidebar's visual surface while contributing essentially no
  user-facing value.
- **The sort dropdown was a freeze trigger.** Each sort click ran a
  full O(N log N) sort on a 750k-row in-memory dataset, blocking the
  main thread for 2-10 seconds. Six of the eight options
  (`first_seen:desc`, `first_seen:asc`, `company:desc`, `level:asc`,
  `level:desc`, `posted_at:asc`) were either developer-facing or
  duplicated by existing filter chips. Only "newest first" matched
  what the overwhelming majority of visitors wanted.
- **The default-expanded sidebar overflowed the viewport** and forced
  an internal scroll context on top of the page scroll, which read as
  jarring "two scrollbars" UX.

## Decision

### Primary filter axes

The filter sidebar's default-expanded groups are **Workplace** and
**Posted**. Both are surfaced at the top of the sequence, expanded on
first visit. These two cover the most common discovery questions —
"is this remote?" and "is this fresh?" — without further interaction.

### Demoted groups

**Level** sits in position 3, collapsed by default. It's still useful
once a visitor has narrowed their search, but isn't part of the first
discovery pass. **Min comp**, **Status** (hide-recruiter, hide-stale),
and **Personal** (saved/applied/ignored) are collapsed and below.

**Personal auto-expands** once on mount when the visitor has any
saved/applied/ignored items in `localStorage`. First-time visitors
with empty collections see it collapsed; returning visitors with
state see it open and find their existing collections in one click.

**ATS** moves to the bottom-most position, collapsed by default. The
group is preserved (a power user avoiding a specific ATS for
accessibility / process reasons can still reach it in one click) but
no longer dominates the sidebar.

Per-user expansion preferences persist in `localStorage` keyed by
group id (`group-storage.ts`); the defaults above are first-visit
state only.

### No sort UI

The sort dropdown is removed entirely. The default order is
`posted_at:desc` (newest first). The `sort` URL parameter still
parses for back-compat — old shared-search links containing
`?sort=…` continue to load — but unhandled sort values fall back to
the default. Column-header click-to-sort remains as a power-user
affordance; it runs the same heavy filter pass under the same busy
indicator.

## Consequences

### Positive

- Sidebar fits a typical viewport without an internal scrollbar
  (collapsed groups occupy ~40 px each instead of 150-200 px).
- First-time visitors see two relevant filter axes immediately;
  nothing they care about is hidden behind a discovery click.
- Returning visitors find their saved-roles collection without
  digging — Personal auto-expands when it has content.
- Removed sort dropdown eliminates ~30 LOC, six hidden-but-loaded
  comparator branches, and seven unused click paths that triggered
  the 750k-row sort blocking pass.
- Click-target audit: every default-visible filter is an accordion
  header (44 px tap target). No 16 px text-only sort affordance to
  fail WCAG 2.5.5.

### Neutral

- Filter state still carries `ats[]` and `sort` — URL back-compat is
  intact. Old shared filter URLs continue to apply their selections;
  ATS chips just have to be reached by clicking the ATS group open.
- Power users who actively sort by company A→Z or by level can no
  longer toggle that from the chip strip; the column-header sort
  still works for the columns that have it.

### Negative

- Visitors who specifically wanted to filter by hiring platform now
  take one extra click to get there. This is the trade-off we're
  accepting: optimising for the 95% case at the cost of the 5%.
- Lost discoverability: a curious user can no longer see the full
  list of supported ATSes by glancing at the sidebar. The README
  carries the canonical list; the about page (when it exists) will
  too.

## Alternatives considered

- **Keep the sort dropdown, fix performance.** Worker-thread sort
  would have moved the freeze off the main thread but kept seven
  user-facing options nobody chose. Removing the UI is cheaper and
  clearer.
- **Drop ATS from the sidebar entirely.** The first iteration of this
  decision did exactly that. Reverted because power users (people
  avoiding a specific ATS for accessibility or process reasons) lost
  the ability to filter on it without manually editing the URL.
  Bottom-of-sidebar collapsed is the right balance.
- **Keep all groups expanded and accept the second scrollbar.** This
  is what shipped pre-ADR; the UX was actively confusing. Discarded.
- **Move filters into a single drawer on every viewport.** Loses the
  desktop "filters always visible" affordance for negligible gain.
  The mobile sheet handles the small-screen case already.
