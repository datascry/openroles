# ADR-0013: Drop the RSS feeds; no subscription model

## Status

Accepted, supersedes [ADR-0009](0009-rss-as-subscription.md).

## Context

ADR-0009 made RSS feeds the canonical subscription model: 35 pre-
rendered XML files (one all-jobs, 24 per-ATS, 10 per-level) shipped at
build time via Astro endpoints reading `bun:sqlite`. The argument was
that an open standard solved subscription without forcing accounts,
email infrastructure, or a backend.

Two years of operation later, the feeds aren't earning their keep:

- The homepage filter UI is the actual discovery surface. Users land,
  filter to what they want, and click Apply. There is no "I want to be
  notified when a new senior remote role lands" flow that the site
  supports beyond "bookmark the filtered URL and revisit."
- The RSS feeds shipped 100 items max, 24-hour TTL. ATSes like
  greenhouse and icims post 100+ roles per day, so a once-daily-poll
  reader silently missed half the new postings. The cap-vs-TTL
  arithmetic never resolved.
- Discovery is by category, not by precise filter. A user wanting
  "remote senior backend engineering at Greenhouse-hosted companies"
  could not subscribe to that — the matrix of pre-rendered feeds
  covered ats OR level, never AND. The combinatorial expansion to
  cover useful subscription shapes (ats × level × workplace × company)
  is at least 24 × 10 × 3 × N ≈ thousands of feeds.
- The 503 fallback for unbuilt-data states baked plaintext into static
  `.xml` files served with `application/xml`. Subscribers' readers
  parsed the placeholder as garbage XML.
- Maintenance cost: shared Job schema, FEED_COLUMNS, rowToJob, three
  Astro endpoints, two libs, ~250 lines of logic + tests, all reading
  the build-time SQLite that ADR-0012 already moved off the deployed
  surface. Continuing to ship descriptions in the feed body kept the
  build-db pipeline complicated.

The minimum objective for the site is "help users find the jobs they
want and click through to apply." RSS adds maintenance surface without
moving that needle.

## Decision

Remove the RSS subscription surface entirely. Specifically:

1. **Delete** `site/src/pages/feed.xml.ts`,
   `site/src/pages/feed/{ats}.xml.ts`,
   `site/src/pages/feed/level/{level}.xml.ts`.
2. **Delete** `site/src/lib/rss.ts`,
   `site/src/lib/feed-builder.{ts,test.ts}`,
   `site/tests/pages-feed.test.ts`.
3. **Delete** `selectFeedJobs` (and the now-unused `FEED_COLUMNS`,
   `JobRow`, `rowToJob` helpers) from `site/src/lib/db.ts`. The only
   remaining build-time SQLite consumer is `selectFirstPaintJobs` for
   SSR seed rows + `selectTenants` for the masthead headcount.
4. **Remove** the RSS link from the masthead nav and the `<link
   rel="alternate" type="application/rss+xml">` from `BaseLayout`.
5. **Delete** `specs/rss-feeds.md`.
6. **Update** `docs/adr/0009-rss-as-subscription.md` to point at this
   ADR for the rationale, but keep the original spec text intact so a
   future server-backed deployment has a reference.

The deployed `/feed.xml` and `/feed/...` URLs return 404 from this
deploy onward. Subscribers who still poll see a 404, their reader
flags the feed as dead, they unsubscribe.

## Consequences

### Positive

- ~250 lines of code + tests removed.
- One fewer reason for the build to read the SQLite. Any future move
  toward an even leaner build (e.g., emitting slim-index directly from
  scrape JSON, no SQLite intermediate) becomes simpler.
- The cap-vs-TTL bug, the 503 placeholder bug, and the
  description-on-the-wire inconsistency with ADR-0012 all go away.

### Neutral

- The "open standard solves subscription" argument is real, but
  unrealised on this corpus given the discovery pattern that emerged.

### Negative

- A genuinely-RSS-using subscriber loses their feed on next deploy.
  Telemetry never showed enough subscribers to make this a real cost.
- If we later want subscriptions back, we are paying the
  reintroduction tax. The archived ADR-0009 + this ADR document the
  decision tree so a future revival has a starting point.

## Alternatives considered

- **Keep `/feed.xml` only, drop per-ATS and per-level.** Reduces 35
  files to 1, addresses the cap-vs-TTL mismatch (one feed of 100
  newest doesn't pretend to be a precise filter). Rejected because
  the all-jobs feed without filtering doesn't match any real
  subscription intent on a 750k-row corpus.
- **Bump cap and lower TTL.** Doesn't address the
  subscription-precision problem; a 200-item / 6-hour feed still only
  covers all-jobs-or-by-axis, not arbitrary intersections.
- **Add ats × level combined feeds.** 240 files. Doesn't address the
  fundamental "no one is subscribing to these in volume" signal and
  it requires another spec round on cross-axis URL design.
- **Build subscriptions properly with email + accounts.** Out of
  scope for a static GitHub Pages site. Documented in
  `docs/server-deployment-reference.md` as future work for a
  Postgres-backed deployment.
