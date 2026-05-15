# Google Jobs RSS feed adapter (`gjobsfeed`)

## Why

Several large employers run SuccessFactors (or other proprietary
stacks) whose machine API is `robots.txt`-disallowed, but front their
careers site with a TalentBrew/Radancy layer that publishes a **Google
for Jobs RSS feed** — an RSS 2.0 document in the
`xmlns:g="http://base.google.com/ns/1.0"` namespace whose every
`<item>` is a complete job posting (title, full description HTML,
canonical link, stable id, employer, function, location).

This feed exists *specifically* to be machine-read (Google ingests it
for the Jobs widget), is served without auth, and is permitted by the
brand's `robots.txt`. It is therefore the correct, policy-compliant
source for these brands — strictly better than fighting the
robots-blocked backend API.

First verified seeds: **SAP** (`jobs.sap.com`, ~255 jobs) and
**ExxonMobil** (`jobs.exxonmobil.com`, ~464 jobs). Both are
SuccessFactors-backed and were `0`-role under the `successfactors`
adapter because the SF `careersection` API is `Disallow: /`.

## Tenant identity

`(slug, feed_url)`. The slug names the brand; `metadata.feed_url` is a
full URL to the brand's Google Jobs RSS feed. The platform under the
hood is opaque — this adapter is vendor-neutral, like `jsonld`. A
tenant record without `metadata.feed_url` is marked `dead` by the
dispatcher (mirrors the `jsonld` / `workday` mandatory-metadata
convention).

## Feed shape

```
<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">
  <channel>
    <title>…</title>
    <item>
      <title>2026UKH - Lead Power Quantitative Risk Modeler (London, LND, GB)</title>
      <description><![CDATA[ …full job HTML… ]]></description>
      <link>https://jobs.exxonmobil.com/ExxonMobil/job/…/1367059400/</link>
      <guid isPermaLink="false">1367059400</guid>
      <g:id>1367059400</g:id>
      <g:expiration_date>2026-06-14</g:expiration_date>
      <g:employer>ExxonMobil</g:employer>
      <g:job_function>Finance, accounting and tax</g:job_function>
      <g:location>London, LND, GB</g:location>
    </item>
    …
  </channel>
</rss>
```

### Field mapping

| Job field            | Source                                   |
|----------------------|------------------------------------------|
| `source_id`          | `g:id` (fallback `guid`, fallback `link`) |
| `title`              | `<title>`                                |
| `url`                | `<link>`                                 |
| `description_html`   | `<description>` (CDATA HTML)             |
| `location_text`      | `g:location`                             |
| `workplace_hint`     | `g:location`                             |
| `department`         | `g:job_function` (when present)          |
| `company`            | tenant `display_name` → `g:employer` → slug |
| `posted_at`          | *omitted* — the Google feed carries only `g:expiration_date`, never a post date |
| `is_recruiter_post`  | title heuristic (`isRecruiterTitle`)     |

`buildJob` (shared) handles id hashing, description→excerpt, location
split, and workplace classification — the adapter only normalises the
feed into `BuildJobInput`.

## Orchestration

- **One** GET against `metadata.feed_url`. No per-job fan-out (the feed
  is self-contained), so there is no N-page SSRF surface — but the
  feed URL itself still passes `isSafeFetchHost` (no loopback / RFC1918
  / metadata IP, https only) before any request fires, same guard the
  probe builder applies.
- The feed is bounded by the brand's open-req count (hundreds, not
  tens of thousands). No per-tenant job cap, consistent with `jsonld`
  (truncating defeats the maximum-coverage purpose).
- An item missing `title` **or** a usable source id is skipped; the
  rest of the feed still yields. Items are de-duplicated by `Job.id`.
- `TenantResult.status`:
  - `success` — feed parsed, ≥0 jobs.
  - `transient_failure` — feed fetch threw / non-2xx, or the document
    parsed but contained zero `<item>` elements under a present
    `<channel>` (usually a transient upstream blip; retained for retry
    rather than marked `dead`).
  - `dead` — `feed_url` missing/invalid/unsafe host.

## Probe

`metadata.feed_url` is the probe target. A 2xx with an RSS body is
live; missing/invalid/unsafe `feed_url` short-circuits to `transient`.
Mirrors the `jsonld` probe-URL builder (`sitemap_url` → `feed_url`).

## Discovery

Hand-seeded, exactly like `jsonld`. A no-op CDX harvest pattern keeps
the `HARVEST_ATS_IDS == ATS_IDS` invariant intact; operators add
tenants by writing `data/tenants/gjobsfeed.json` records with
`metadata.feed_url`. The weekly reprobe matrix promotes
`transient_failure` seeds to `live`.

## Schema impact

Adds the `gjobsfeed` ATSId → **major** schema bump (4.0.0 → 5.0.0):
`ATSCountsSchema` is `.strict()`, so a 4.0.0 reader rejects a 5.0.0
manifest carrying `ats_counts.gjobsfeed = 0`. Same rule as the
3.0.0 (`jsonld`) and 4.0.0 (`brassring`) additions.

## Test discipline

- Fixture-replay: SAP feed, ExxonMobil feed (real, trimmed to 3 items
  each), and an edge fixture (missing g:id, missing title, empty
  channel, malformed XML).
- Property: parser deterministic on the same input.
- Dispatcher: missing `feed_url` → `dead`; unsafe host → `dead`;
  non-2xx → `transient_failure`; `Disallow: /` robots blocks the
  fetch.
