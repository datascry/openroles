# ADR-0015: Phase-6 custom ATS scrapers (Amazon, Apple, TikTok, Meta)

## Status

Accepted

## Context

Phase-plan row 6 (`docs/adr/0010-phase-plan.md`) — "Anti-bot driver for
session-locked tenants" — was marked deferred until needed. It became
needed when the survey of big-brand coverage on the corpus revealed that
the FAANG-custom subset (companies whose hiring runs on bespoke
infrastructure rather than a mainstream ATS) is the single largest
remaining gap, and the gap is widening as more big employers migrate
from Taleo / iCIMS / SuccessFactors to custom careers stacks.

Specifically: Amazon, Apple, TikTok/ByteDance, and Meta each operate a
**single-tenant** careers stack with a public-but-undocumented
JSON-ish search API. Each looks just enough like a "normal" ATS to fit
the existing dispatch model, but slug shape (single canonical name),
URL layout (single host), and pagination semantics differ enough per
vendor that one shared scraper would be a fiction.

The alternative — a generic headless-browser-driven scraper — was
considered and rejected for now: every endpoint we need works on
plain HTTPS with a polite User-Agent, so the additional 70-100 MB
Playwright runtime and the slowness of full-page renders aren't
justified by the failure modes we'd actually be solving.

## Decision

Each FAANG-custom careers stack becomes a distinct **`ATSId`**:

- `amazonjobs` — `amazon.jobs/en/search.json` (GET, paginated, public)
- `applejobs` — `jobs.apple.com/api/role/search` (POST + JSON body, paginated)
- `tiktokcareers` — `careers.tiktok.com/api/v1/search/job/posts` (POST + JSON body, paginated, envelope `{code, data}`)
- `metacareers` — `metacareers.com/api/jobs` (POST + JSON body, paginated)

Each is single-tenant (slug == company name, dispatcher rejects any
other slug). Adds 4 entries to `ATS_IDS`, bumps `SCHEMA_VERSION`
from 1.5.0 → 1.6.0 in one step. Each adapter follows the
SuccessFactors shape: a pure `parseXxxJobs()` plus an impure
`scrapeXxxTenant()` paginator, fixture-replay tests, property
tests for determinism, and dispatcher integration tests.

Probe URL is the GET-friendly public landing page (not the POST-only
API the scraper hits). Harvest patterns capture the canonical slug
from the URL host as a literal group; CDX discovery yields a single
record per ATS rather than a multi-tenant sweep.

No anti-bot framework yet. If a tenant's endpoint starts blocking
us — most likely Apple, which has historically rate-limited
non-mobile-Safari User-Agents — the recovery path is per-vendor:
adjust the UA, add per-host delay, or fall back to a headless
browser, decided when the failure mode is observed.

## Consequences

### Positive

- The "five obvious missing brands" problem (Apple, Meta, Amazon,
  TikTok, plus one more covered by SuccessFactors / hand-seeded
  Workday) is resolved.
- Each scraper is self-contained; failure of one doesn't cascade.
- Fixture-replay coverage is full per scraper.
- Harvest is a no-op for these (CDX captures the host trivially); a
  single discovery pass primes each tenant entry and reprobe verifies.

### Neutral

- ATS_IDS widens 25 → 29; this is the second widening in two sessions
  (the first added `successfactors`). Manifest reads of older
  databases stay clean because `ats_counts` auto-defaults missing
  keys to 0.
- Schema versions are accumulating quickly. Once Phase-6 lands the
  natural next versioning event is the role-detail surface
  (`specs/role-detail.md`), not another ATS widening.

### Negative

- **PRELIMINARY caveat** — fixture shapes are based on documented and
  empirically-observed public response formats; live validation
  against a real tenant for each ATS is pending. The scrapers degrade
  safely (per-job `JobSchema.safeParse` drops malformed candidates),
  but the first live run may need fixture updates if a vendor has
  shipped a breaking change since the schemas were captured.
- Anti-bot risk per vendor:
  - Amazon: public JSON; lenient.
  - Apple: documented to rate-limit; mitigation = polite UA, retry
    via HttpClient's existing exponential backoff.
  - TikTok: cloudflare-fronted; lenient on the search endpoint as
    of latest survey.
  - Meta: cloudflare-fronted; can fingerprint TLS but the JSON path
    works on Bun's native fetch as of writing.

  If any of these starts hard-blocking, the cleanest forward path is
  a Playwright-based fallback scoped to the one ATS that needs it,
  not a system-wide anti-bot rewrite. We'll write that ADR when it
  becomes necessary.

- These ATSes do not participate in the harvest/reprobe machinery
  the same way multi-tenant ATSes do. Discovery is one-shot; reprobe
  exists only to detect the tenant going dark (the API endpoint
  changing or going behind auth), not to enumerate new slugs.
