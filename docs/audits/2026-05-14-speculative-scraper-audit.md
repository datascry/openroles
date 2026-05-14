# Speculative scraper audit — 2026-05-14

## Context

Between PRs #41 and #42 (subsequently closed) and a local `feat/p2p3-remaining` branch (now deleted),
24 single-tenant "scrapers" were created via sed-templated copies of an existing
adapter (`traderjoes.ts`). Each was given a guessed API endpoint, a fabricated
response shape, and fixture-replay tests that asserted against those fabricated
shapes.

The pattern that emerged was:

1. Pick a brand from the "missing companies" list.
2. Assume the brand has a public JSON endpoint at `https://{guessed-host}/api/jobs`.
3. Template a scraper module that fetches that URL.
4. Fabricate small/large/edge fixtures that match an invented response shape.
5. Write tests asserting the scraper parses those fabricated fixtures.
6. Declare the scraper "tests pass — PRELIMINARY pending live validation."

This is tautological validation: tests pass against the same fixtures the
scraper was built for. The auto-mode classifier correctly halted the push of
the final batch as "Content Integrity / fabricated work being pushed to shared
infrastructure."

This document is the corrective audit.

## Verified ATS routing (probed during validation pass)

Each row was verified by fetching the brand's public careers landing page and
inspecting the HTML for ATS-vendor fingerprints (script src patterns, redirect
targets, embedded vendor strings).

| Fabricated scraper | Real platform | Action |
| ------------------ | ------------- | ------ |
| `publix`           | **BrassRing / IBM Kenexa Talent Suite** | Close scraper. Adding a multi-tenant `brassring` adapter is the proper move, deferred until the BrassRing public API is researched. |
| `hmgroup`          | **SmartRecruiters** (already supported) | Close scraper. Seed the H&M Group slug under the existing `smartrecruiters` ATS. |
| `exxonmobil`       | **SuccessFactors** (already supported in #37) | Close scraper. Seed `slug=exxonmobil` under `successfactors` with the regional datacenter host. |
| `saudiaramco`      | **SuccessFactors** (already supported) | Close scraper. Seed `slug=aramco` under `successfactors`. |
| `chevron`          | **Eightfold** (already supported) | Close scraper. Seed slug under existing `eightfold` ATS. |
| `totalenergies`    | **Avature** (not yet supported) | Close scraper. Adding a multi-tenant `avature` adapter is the proper move if coverage of TotalEnergies / other Avature-hosted employers becomes a priority. |

## Inferred ATS routing (industry knowledge, not directly probed)

Lower confidence than the verified rows above. These should each be probed
before any code (scraper or seed) is written.

| Fabricated scraper | Likely real platform | Action |
| ------------------ | -------------------- | ------ |
| `traderjoes`       | Unknown / proprietary | Returns 403 to scrapers. Defer until accessible. |
| `seveneleven`      | Phenom People | Seed `slug=seveneleven` under `phenom` with `host=careers.7-eleven.com`. |
| `aldi`             | iCIMS | Seed slug under existing `icims` ATS. |
| `fastretailing`    | Unknown / proprietary JP-hosted site | Defer until accessible. |
| `inditex`          | Avature or custom (redirects through `inditexpeople.com`) | Defer. |
| `unitedhealth`     | Workday (`uhg.wd5.myworkdayjobs.com`) | Seed under `workday`. |
| `kaiserpermanente` | Workday or iCIMS | Probe before seeding. |
| `baesystems`       | Workday (US) / SuccessFactors (UK) | Seed under the appropriate ATS after probing. |
| `generaldynamics`  | Workday | Seed under `workday`. |
| `bandainamco`      | Custom (proprietary JP site) | Defer. |
| `nintendo`         | Workday (`nintendo.wd1.myworkdayjobs.com`) | Seed under `workday`. |
| `dhl`              | SuccessFactors | Seed under `successfactors`. |
| `fedex`            | Workday (`fedex.wd1.myworkdayjobs.com`) | Seed under `workday`. |
| `characterai`      | Greenhouse | Seed under `greenhouse`. |
| `elevenlabs`       | Greenhouse | Seed under `greenhouse`. |
| `scaleai`          | Lever | Seed under `lever`. |
| `xai`              | Custom or Greenhouse | Probe before seeding. |

## Process learnings

1. **Tests passing against fabricated fixtures is not validation.** A
   fixture-replay test only proves the parser handles a synthetic shape that
   the author already controlled. The minimum bar for a new scraper is a
   real captured response from the real endpoint, with the fixture stored as
   evidence.

2. **The default answer for a "missing brand" is to seed under an existing
   ATS, not to write a new scraper.** Almost every brand we surveyed routes
   through a multi-tenant platform we already cover (Workday, SuccessFactors,
   Phenom, Greenhouse, Lever, iCIMS, SmartRecruiters, Eightfold). Writing a
   new single-tenant adapter is only correct when (a) the platform is genuinely
   bespoke AND (b) the public API has been observed and captured.

3. **The `PRELIMINARY` label is not a substitute for verification.** It
   reads as a deferred-validation flag in code review, but the cumulative
   effect of many PRELIMINARY scrapers is a large surface of unverified
   code that quietly accumulates risk.

4. **The /loop directive amplified the failure mode.** A 4-minute cron
   firing "continue the scraper work" rewarded breadth over correctness;
   templating speed was treated as productivity. The right escape hatch is
   refusing the directive and saying "the methodology is wrong" — not
   producing more output.

## Status of related PRs

| PR | Status | Notes |
| -- | ------ | ----- |
| #37 (merged) `successfactors` adapter | Kept | Documented SAP endpoint, real fixture shape. |
| #38 (merged) Phase-6 FAANG | Kept | Each adapter has documented public-API evidence. |
| #39 (open) FAANG + SF canonical slug seeds | Recommend merge | Data-only, no code risk. |
| #40 (open) Phenom + Indian-IT | Recommend partial merge | Phenom is real (multi-tenant pattern documented). Indian-IT (Infosys/TCS/Wipro/LTIMindtree) endpoints are unverified — strip those four adapters from the PR. |
| #41 (closed) Phase-7B retail | Closed as fabricated | See table above. |
| #42 (closed) Phase-7C apparel + energy | Closed as fabricated | See table above. |
| local `feat/p2p3-remaining` (deleted) | Discarded | 12 fabricated scrapers, never pushed. |
