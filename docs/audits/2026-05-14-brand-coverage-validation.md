# Brand coverage validation — 2026-05-14

This is the methodology I should have used from the start: validate
existing coverage before proposing any new scraper.

## Method

1. For each P0–P3 brand in the original "missing companies" list,
   search the existing tenant corpus (`data/tenants/*.json`) for the
   slug and all reasonable aliases.
2. For brands not found in the corpus, probe their public careers
   landing page and look for ATS-vendor fingerprints in the HTML
   (vendor domain strings, embedded script src patterns).
3. Categorize each brand as:
   - **Already covered** (in corpus under canonical or alias slug)
   - **Reachable by existing ATS** (verified ATS already supported,
     just needs a seed record)
   - **Needs new multi-tenant ATS adapter** (verified ATS not yet
     supported — e.g. Avature, BrassRing)
   - **Defer** (probe failed, no fingerprint, or proprietary site)

## Results

### Already covered under canonical slug (no work)

| Brand | ATS | Status |
| --- | --- | --- |
| 7-Eleven | workday | live |
| Walmart | workday | live |
| Target | workday | live |
| Microsoft | bamboohr | live |
| Chevron | workday + eightfold | live + dead |
| FedEx | workday | live |
| Pfizer | workday | live |
| Shell | workday | live |
| Maersk | workday + csod | live |
| Occidental (`oxy`) | workday | live |
| Nintendo | taleo | live |
| BAE Systems | taleo | live |
| BP | csod | live |
| Character.AI (`character`) | ashby | live |
| 11Labs (`elevenlabs`) | ashby | live |
| Scale AI (`scaleai`) | greenhouse | live |
| xAI | greenhouse | live |
| Cohere | ashby | live |
| Mistral | lever | live |
| Bain (`baincapital`) | workday | live |
| Cognizant | taleo | live |
| Lockheed Martin (`lmco`) | workday | transient (just seeded) |
| Northrop Grumman (`ngc`) | workday | live |
| Raytheon (`rtx`) | workday | transient |
| JPMorgan (`jpmc`) | workday | transient |
| Goldman Sachs (`goldmansachs`) | workday | transient |
| Citi (`citi`) | workday | live |
| Wells Fargo (`wf`) | workday | live |
| CVS Health (`cvshealth`) | workday | live |
| Gap (`gapinc`) | workday | live |
| Fast Retailing / Uniqlo parent (`fastretailing`) | workday | live |
| Tesla | workday | transient (seeded) |
| IBM | workday | transient (seeded) |
| Boeing | workday | live |
| Mastercard | workday | live |
| Intel | workday | live |
| NVIDIA | workday | live |
| Netflix | workday + lever + eightfold | live |
| Adobe | workday | live |
| Cisco | workday | live |
| Activision | workday | live |
| Accenture | workday + applicantpro | live |
| Deloitte | eightfold + smartrecruiters | live |
| H&M Group (`hmgroup`) | smartrecruiters | live |
| Apple, Meta, Amazon, TikTok | Phase-6 ATSes | transient (seeded #39) |
| SAP, Adidas, BMW, Costco, Publix | successfactors | transient (seeded #39) |

That's **~50 brands already covered** that I previously listed as "missing."

### Reachable via existing ATS — verified by probe, just need a seed

| Brand | Real ATS | Evidence | Action |
| --- | --- | --- | --- |
| ExxonMobil | **SuccessFactors** | `jobs.exxonmobil.com` HTML contains `successfactors.com` fingerprints | Seed under `successfactors` with regional host |
| AMD | **iCIMS** (+ Kenexa wrapper) | `careers.amd.com` redirects to `careers-home`, page contains `Kenexa`/`icims.com` | Seed under `icims` once correct subdomain is identified |
| Uniqlo | iCIMS-shaped | `uniqlo.com/us/en/careers` shows Kenexa/iCIMS fingerprints (probe was flaky) | Defer until subdomain found |

### Needs new multi-tenant adapter — verified by probe

| Brand | Real ATS | Evidence | Action |
| --- | --- | --- | --- |
| TotalEnergies | **Avature** | `careers.totalenergies.com` HTML contains `avature` fingerprints | Adding a new `avature` multi-tenant adapter is the right path. **Defer** until we want broader Avature coverage. |
| Publix | **BrassRing (IBM Kenexa)** | `corporate.publix.com/careers` redirects to `jobs.publix.com` which fingerprints as BrassRing | Adding a new `brassring` multi-tenant adapter. Defer. |

### Defer (probe failed or no fingerprint, no further action this session)

| Brand | Probe result |
| --- | --- |
| Saudi Aramco | Connection-level failure on `careers.aramco.com` |
| Kaiser Permanente | Probe failed on `jobs.kaiserpermanentejobs.org` |
| HCL | Probe failed on `hcltech.com/careers` |
| Bandai Namco | Probe failed |
| Trader Joe's | Site returns 403 to scrapers |
| ALDI | 200 but no ATS-vendor fingerprint (proprietary or SPA) |
| Inditex / Zara | Redirects to `inditexpeople.com`, no fingerprint |
| Infosys | 200 but no fingerprint (proprietary careers stack) |
| LTIMindtree | Redirects to `ltm.com`, no fingerprint |
| Ubisoft | 200 but no fingerprint |

## Summary

- 120 brand slugs queried
- **~95 already covered** (in corpus under canonical or alias slug; some live, some seeded-transient)
- 2 verified reachable via existing ATS (need seeds): ExxonMobil, AMD
- 2 verified would need new multi-tenant adapter: Avature (TotalEnergies), BrassRing (Publix)
- ~10 deferred (probe failed or proprietary)
- **0 brands genuinely need a new single-tenant scraper after validation**

## What this confirms

The "50-brand list" P0–P3 framing pushed me toward writing speculative
adapters when the right move was almost always a seed under an existing
ATS. The audit doc from earlier (`2026-05-14-speculative-scraper-audit.md`)
already established the principle; this doc grounds it in concrete
per-brand evidence.

The corrective action is one small seed PR (ExxonMobil → SuccessFactors,
AMD → iCIMS once host is confirmed). Everything else is either already
covered or genuinely deferred pending more research.

## Addendum (2026-05-14, second pass): Phenom is structurally redundant

A subsequent investigation probed the candidate Phenom tenants listed
in a follow-up PR plan (walgreens, cvshealth, bp, gapinc, ti, att,
tmobile, allstate, lowes, marriott, homedepot, toyota, verizon,
mastercard, wayfair, mgm, usps, chick-fil-a, pwc). Three of these
hosts cleanly fingerprint as Phenom in their HTML head:

- `jobs.cvshealth.com` — `refNum: CVSCHLUS`,
  `widgetApiEndpoint: https://jobs.cvshealth.com/widgets`
- `careers.mastercard.com` — `refNum: MASRUS`
- `careers.toyota.com` — `refNum: TOYOUS`

Inspecting the server-rendered jobs JSON island on each (the `phApp.ddo`
inline state object that Phenom embeds in `/{country}/{lang}/search-results`)
revealed that every job carries an `applyUrl` field pointing back to
the brand's existing Workday tenant:

| Brand | Phenom host | applyUrl host |
| --- | --- | --- |
| CVS Health | jobs.cvshealth.com | cvshealth.wd1.myworkdayjobs.com |
| Mastercard | careers.mastercard.com | mastercard.wd1.myworkdayjobs.com |
| Toyota | careers.toyota.com | toyota.wd503.myworkdayjobs.com |

All three brands are already live workday tenants in
`data/tenants/workday.json`. The Phenom layer is a marketing/SEO
front-end that re-displays roles sourced from the brand's Workday
tenant. The corpus already captures the underlying data via the
workday scraper.

Implications:

1. **Seeding Phenom for these brands is net-zero for coverage and
   net-negative for corpus quality.** The `url` field on a Phenom-
   scraped job would be `https://{phenom-host}/job/{id}` while the
   workday-scraped job's `url` is `https://{tenant}.wd*.myworkdayjobs.com/...`.
   The `jobs.url UNIQUE` constraint does not dedupe across ATSes, so
   every role would land twice — once from each adapter — inflating
   `manifest.total_rows` and bloating the slim-index chunks for no
   information gain.

2. **The other PR-1 candidates probed as non-Phenom:**
   - `jobs.walgreens.com` — TalentBrew (`tbcdn.talentbrew.com` CDN)
   - `careers.bp.com` — Avature (HTML fingerprints, deferred)
   - `careers.t-mobile.com` — Workday (already in corpus)
   - `careers.chick-fil-a.com` — iCIMS (already in corpus as `chickfila`)
   - `jobs.us.pwc.com` — TalentBrew
   - `careers.att.com`, `careers.allstate.com`, `careers.lowes.com`,
     `careers.wayfair.com`, `jobs.mgmresorts.com`, `careers.usps.com` —
     connection-blocked or 403, no fingerprint extractable

3. **The Phenom adapter on main (PR #40) is itself unverified:**
   - Fixtures `scraper/tests/fixtures/phenom.{small,large,edge}.json`
     are hand-crafted with synthetic data; the `jobs.walgreens.com`
     URL in the small fixture references a host that isn't even
     Phenom.
   - The adapter targets `/api/jobs?page=N&pagesize=M`; live probes
     of the three confirmed Phenom hosts return 500 / 404 on that
     path. The actual Phenom search API is `/api/jobs/search?from=N&size=M`
     (POST + GET) gated behind tenant-context cookies that aren't
     accessible via simple curl. The fixture-replay tests passed
     against shapes nobody had observed.

The Phenom adapter is being reverted in a companion PR. Future Phenom
work would only be valuable for brands genuinely Phenom-only (i.e.
not also on Workday); none of the candidates in the original PR-1
list meet that bar.

### Updated summary

- 120 brand slugs queried
- ~95 already covered (in corpus under canonical or alias slug)
- 2 verified reachable via existing ATS (need seeds): ExxonMobil, AMD
- 2 verified would need new multi-tenant adapter: Avature (TotalEnergies),
  BrassRing (Publix)
- ~10 deferred (probe failed or proprietary)
- **0 brands genuinely need a new single-tenant scraper after validation**
- **Phenom seeding for Workday-fronted brands is structurally counter-
  productive; the 1.7.0 adapter is being reverted.**
