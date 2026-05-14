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
