# ATS apply-link redirection audit — 2026-06-05

## Context

Every rendered row links its title and its `Apply →` button directly to the
source ATS via `Job.url` (`FilterTable.svelte` and `FirstPaintRows.astro`,
`href={row.url}` / `href={r.url}`, `target="_blank" rel="noopener noreferrer"`).
There is no intermediate role-detail page (ADR-0012), so `Job.url` is the only
thing standing between a click and the employer's apply form.

This audit answers two questions:

1. **Construction** — how does each of the 32 ATS adapters derive `Job.url`,
   and can it produce a wrong or non-apply destination?
2. **Redirection** — when a real, rendered URL is followed, does it land on the
   specific posting, or does it bounce somewhere else (listing page, vendor
   homepage, 404)?

### Method

- Static review of `url:` assignment in every wired adapter under
  `scraper/src/ats/` (32 ATSes in `ATS_IDS` / the `scrape.ts` dispatch;
  `common.ts`, `jsonld-core.ts`, `workday-site*.ts` are shared helpers, not
  adapters).
- Live validation: the real adapters were run against live tenants (the same
  `runScrape` path the daily refresh uses), the emitted `Job.url` values were
  collected, then each was followed with an HTTP client using a browser
  `User-Agent`, recording first-hop status, redirect count, and final URL.
- 27 ATSes yielded live samples (≈69 distinct URLs probed, ≥3 per ATS where
  available). 6 ATSes emitted no links this run (see *Adapter health* below).

## Validation pipeline (what already protects the link)

`Job.url` is typed `HttpUrl` (`shared/src/schema/url.ts`): `z.url()` plus a
refinement requiring an `http(s)` scheme. Every adapter runs each candidate
through `JobSchema.safeParse(...)` and pushes **only on success**; `build-db`
re-validates each scrape file via `ScrapeOutputSchema` (which embeds
`JobSchema`). Consequences:

- **`javascript:` / `data:` / relative / malformed URLs cannot render** — they
  fail `HttpUrl` and the *entire job is dropped*. The XSS class for
  `<a href>` is closed.
- The residual risk is therefore **not** a broken/hostile href; it is a URL
  that *passes* `HttpUrl` (valid `https`) but points at the **wrong place**.
  `HttpUrl` does not check the host or path, so a valid-but-wrong destination
  renders silently. That is exactly what "proper redirection" must catch, and
  it is what the live probe targets.

## Findings

### 1. SmartRecruiters — deep link redirected to the company listing (HIGH) — FIXED

Every SmartRecruiters apply link pointed at the wrong host. The adapter emitted
`https://careers.smartrecruiters.com/{tenant}/{id}`. The `careers.` host is the
company's **listing** page only — a `/{tenant}/{id}` deep link there
`302`-redirects to the bare `/{tenant}` listing, dropping the posting id. A user
clicking `Apply →` for a specific role landed on the employer's full job list
instead of the role.

Verified live across two distinct tenants:

| Emitted URL (before) | First hop | Final |
| --- | --- | --- |
| `careers.smartrecruiters.com/2talent-mijnnieuwecarriere/743999865899001` | `302` | `careers.smartrecruiters.com/2talent-mijnnieuwecarriere` (listing) |
| `careers.smartrecruiters.com/3hpartners/744000126260360` | `302` | `careers.smartrecruiters.com/3hpartners` (listing) |

The per-posting host `jobs.smartrecruiters.com/{tenant}/{id}` serves the job
card directly (`200`, **0 redirects**), accepts the lowercase tenant slug, and
needs no trailing title slug:

| Emitted URL (after) | First hop | Final |
| --- | --- | --- |
| `jobs.smartrecruiters.com/2talent-mijnnieuwecarriere/743999865899001` | `200` | same (the posting) |
| `jobs.smartrecruiters.com/3hpartners/744000126260360` | `200` | same (the posting) |

The adapter's own comment claimed `careers.smartrecruiters.com` "renders the
job card by id" — that was false for the `careers.` host. A contributing cause:
the test suite asserted on the API request URLs, descriptions, and
`workplace_type`, but **never on the emitted `Job.url`**, so the wrong host was
never pinned.

**Fix applied** (`scraper/src/ats/smartrecruiters.ts`): host changed
`careers.` → `jobs.`, comment corrected. **Test added**
(`scraper/tests/ats/smartrecruiters.test.ts`): asserts
`url === https://jobs.smartrecruiters.com/{tenant}/{id}` for both fixture jobs
(red before the host change, green after). Re-running the fixed adapter on the
two live tenants now emits URLs that resolve `200` with 0 redirects.

**One-time churn (expected, acceptable):** `Job.id` is
`sha256(ats ⋮ tenant_slug ⋮ source_id ⋮ url)` (`shared/src/schema/job-id.ts`),
so changing the host changes the id of every SmartRecruiters row on the next
build. Consequences, all one-build: (a) `first_seen_at` carry-forward in
`build-db` keys off the old id/url and misses, so SmartRecruiters rows reset to
today's `first_seen_at` and briefly read as `NEW`; (b) user-side
saved/applied/ignored localStorage entries (keyed by `Job.id`,
`specs/role-lifecycle.md`) are orphaned for SmartRecruiters roles. A correct
apply link outweighs both, but the churn is real and is noted here and in the
commit body rather than left implicit. The `careers.smartrecruiters.com/*` CDX
**tenant-discovery** query (`scraper/src/harvest/patterns.ts`) is intentionally
left unchanged — Common Crawl indexes the public `careers.` listing pages, which
is how tenant slugs are found; only the per-posting *apply* URL moves to `jobs.`.

### 2. Recruitee — deactivated tenants still link to a dead vendor page (LOW / data freshness)

`malcomfinance.recruitee.com/o/...` `301`-redirects to
`https://recruitee.com/careers_not_hosted`: the tenant's careers site is no
longer hosted, yet the tenant is still `live` in the index and the API still
returns offers. A second recruitee tenant in the same sample resolved `200`
with 0 redirects, so this is **not** a URL-construction defect — the constructed
format is correct. It is a tenant-lifecycle gap: a `careers_not_hosted` bounce
is a strong "tenant is gone" signal the probe could treat as `dead`. Tracked as
an observation, not a link-construction bug.

### 3. Benign canonicalization redirects (informational — all land on the right posting)

These adapters emit a URL that redirects once, but the redirect lands on the
*specific* posting, so the apply experience is correct:

- **workable** — `apply.workable.com/j/{shortcode}` `301`→
  `apply.workable.com/{tenant}/j/{shortcode}` (`200`).
- **pinpointhq** — `{tenant}.pinpointhq.com/en/jobs/{id}` `302`→
  `…/en/postings/{uuid}` (`200`, the canonical posting).
- **greenhouse** — the API already returns the new `job-boards.greenhouse.io`
  host; the legacy `boards.greenhouse.io` `301`→`job-boards…` path is not even
  hit. No action.

### 4. Adapter health — ATSes emitting zero apply links this run (coverage, not redirection)

These produced **no** rendered links, so there is nothing to misdirect — but it
also means their apply-URL format could only be reviewed statically, and the
zero output is itself worth tracking:

| ATS | Emitted links | Cause (observed `tenant_result`) |
| --- | --- | --- |
| `applejobs` | 0 | `dead` — `robots.txt disallows https://jobs.apple.com/api/role/search` (adapter does not set `skipRobots` for this host) |
| `successfactors` | 0 | `dead` — `robots.txt disallows …/careersection/rest/jobboard/search-jobs` (no `skipRobots`) |
| `tiktokcareers` | 0 | `dead` — search API returned `null` (response shape changed) |
| `metacareers` | 0 | `dead` — `HTTP 400` from `metacareers.com/api/jobs` |
| `csod` | 0 | `dead` — `careersite bootstrap unparseable` / robots-blocked for sampled tenants |
| `taleo` | 0 | `success` with 0 jobs — sampled standard-pool tenants genuinely had no open roles (adapter healthy) |

`applejobs` and `successfactors` are the most actionable: a `skipRobots` review
(the same justification already used for greenhouse/smartrecruiters/workable
public APIs) would likely restore coverage. These are scraper-coverage items,
filed here for traceability; they are out of scope for the link-redirection fix.

## Live redirection results — adapters that emitted links

All landed on the specific posting (`200`). `rdr` = redirect count following the
emitted URL.

| ATS | Construction | rdr | Result |
| --- | --- | --- | --- |
| greenhouse | pass-through `absolute_url` | 0 | ✅ posting |
| lever | pass-through `hostedUrl` | 0 | ✅ posting |
| ashby | pass-through `jobUrl` | 0 | ✅ posting |
| workable | shortlink → `apply.workable.com/{tenant}/j/{id}` | 1 | ✅ posting |
| smartrecruiters | constructed (**fixed** → `jobs.` host) | 0 | ✅ posting (was ❌ listing) |
| recruitee | `careers_url`/`url`/constructed | 0\* | ✅ posting (\*1 dead tenant → `careers_not_hosted`) |
| teamtailor | pass-through feed `<link>` | 0 | ✅ posting |
| personio | constructed `{slug}.jobs.personio.com/job/{id}` | 0 | ✅ posting |
| breezy | `url`/`apply_url`/constructed | 0 | ✅ posting |
| bamboohr | `jobUrl`/constructed `…/careers/{id}` | 0 | ✅ posting |
| jobvite | `jobs.jobvite.com/{slug}/job/{id}` (regex-validated href) | 0 | ✅ posting |
| icims | sitemap URL (host + `/jobs/` validated) | 0 | ✅ posting |
| ultipro | constructed `recruiting.ultipro.com/…/OpportunityDetail` | 0 | ✅ posting |
| pinpointhq | `/en/jobs/{id}` → `/en/postings/{uuid}` | 1 | ✅ posting |
| homerun | feed `alternate` link | 0 | ✅ posting |
| factorial | sitemap URL (host + `/job_posting/` validated) | 0 | ✅ posting |
| talentlyft | sitemap URL (host + `/jobs/` validated) | 0 | ✅ posting |
| applicantpro | pass-through `jobUrl` | 0 | ✅ posting |
| applicantstack | regex-validated `…/x/detail/{shortcode}` (host-checked) | 0 | ✅ posting |
| eightfold | sitemap URL (`careers.` + `/careers/job/{id}` validated) | 0 | ✅ posting |
| amazonjobs | `job_path`/constructed `amazon.jobs/en/jobs/{id}` | 0 | ✅ posting |
| workday | constructed `{host}/{site}{externalPath}` | 0 | ✅ posting |
| brassring | `Link`/constructed `sjobs.brassring.com/…JobDetails` | 0 | ✅ posting |
| jsonld | sitemap URL (host + `/jobs?/` + safe-host validated) | 0 | ✅ posting |
| gjobsfeed | pass-through feed `<link>` | 0 | ✅ posting |
| zohorecruit | feed `<link>` `…/jobs/Careers/{id}/…` | 0 | ✅ posting |

## Static review — URL host/path validation by category

- **Host/path validated before emit** (strongest): `applicantstack` (host
  must equal `{slug}.applicantstack.com`), `jobvite` (strict path regex),
  `icims` / `factorial` / `talentlyft` / `jsonld` / `eightfold` (sitemap URLs
  filtered to expected host + job path; `jsonld` also runs `isSafeFetchHost`).
- **Constructed from validated components** (host is hard-coded or
  slug-derived): `taleo`, `applejobs`, `tiktokcareers`, `ultipro`, `personio`,
  `workday` (host/site asserted upstream), `brassring` (numeric id regex),
  `smartrecruiters` (post-fix).
- **Pass-through with scheme-only validation** (`HttpUrl` catches non-`https`
  but not host): `greenhouse`, `lever`, `ashby`, `applicantpro`, `teamtailor`,
  `homerun`, `zohorecruit`, `gjobsfeed`, and the API-provided branch of the
  hybrid adapters (`workable`, `recruitee`, `breezy`, `pinpointhq`, `bamboohr`,
  `amazonjobs`, `metacareers`, `successfactors`). These rely on vendor APIs/feeds
  returning same-host URLs. Live probing found no off-host or non-apply
  destination among them; the residual exposure is theoretical (a compromised
  feed) and bounded by the `https`-scheme requirement.

No `javascript:`/`data:`/relative-URL exposure exists at the render layer — the
`HttpUrl` schema drops such jobs before they reach the index.

## Recommendations

1. **(done)** Ship the SmartRecruiters host fix + the `Job.url` assertion.
2. Add an emitted-`Job.url` assertion to every adapter's test that lacks one, so
   a future host/path regression is caught in CI rather than in production. The
   SmartRecruiters miss was enabled purely by an absent URL assertion.
3. Treat a recruitee `→ recruitee.com/careers_not_hosted` redirect as a
   `dead`-tenant signal in the probe, to stop surfacing links into deactivated
   careers sites.
4. Revisit `skipRobots` for `applejobs` and `successfactors` (documented public
   APIs, same rationale already applied elsewhere) to restore their coverage,
   and re-check the `tiktokcareers` / `metacareers` request shapes against the
   current upstream APIs.
