# Spec: Scraper contract

**Version**: 1.0.0

Each ATS scraper is a function `(input: ScrapeInput) => Promise<ScrapeOutput>` with a uniform contract regardless of the underlying API shape. Per-ATS quirks are encapsulated; the rest of the pipeline depends only on this contract.

## Inputs

```typescript
interface ScrapeInput {
  ats: ATSId;
  tenants: ReadonlyArray<{ slug: string; display_name?: string }>;
  abortSignal?: AbortSignal;     // for cooperative cancellation
  concurrency?: number;          // default 10 per ATS
  userAgent: string;             // canonical User-Agent for this build
  contactUrl: string;            // surfaced in UA so ATS owners can reach us
  retry?: {
    maxAttempts: number;         // default 3
    baseMs: number;              // default 500
    maxMs: number;               // default 30000
  };
  cache: RobotsTxtCache;         // shared instance; honors per-host robots.txt
}
```

## Outputs

```typescript
interface ScrapeOutput {
  ats: ATSId;
  jobs: ReadonlyArray<Job>;
  tenant_results: ReadonlyArray<TenantResult>;
  metrics: {
    started_at: string;          // ISO 8601 UTC
    finished_at: string;
    duration_ms: number;
    requests_made: number;
    requests_failed: number;
    requests_retried: number;
    bytes_received: number;
  };
}

interface TenantResult {
  slug: string;
  status: "success" | "transient_failure" | "dead";
  http_status?: number;
  error?: string;                // human-readable reason; never a stack trace
  jobs_count: number;
}
```

## HTTP etiquette

Every scraper goes through `scraper/src/http.ts`. The contract:

- **User-Agent identifies the project**: `openroles/<version> (+<contactUrl>)` — never spoofed to look like a browser. Per-ATS UA rotation is reserved for cases where an ATS hard-blocks shared-tooling UAs; documented in the per-ATS section if it applies.
- **`robots.txt` is fetched and cached per origin** at the start of a run. Disallow rules block the request. Cache TTL: 24h.
- **Concurrency** capped per ATS via `p-limit(input.concurrency ?? 10)`. The cap is per-ATS, not global, so one slow ATS does not starve another.
- **Retry policy**:
  - 5xx and 429 are transient; retry with exponential backoff (`baseMs * 2^attempt + jitter(±20%)`), capped at `maxMs`. Default 3 attempts.
  - 4xx other than 429 is treated as permanent for that tenant.
  - Honor `Retry-After` headers when present; clamp to `maxMs`.
  - 401/403 triggers a one-time soft retry, then marks the tenant `dead`.
- **Timeouts**: 30 seconds per request, including TLS handshake. Use `AbortSignal.timeout(30000)`.
- **No cookies stored or replayed** — every request is independent. Session-locked tenants are routed through the anti-bot driver (Phase 6), not through this contract.

## Per-ATS notes

Implementation details for each ATS live in `scraper/src/ats/{ats}.ts`. Each implementation must:

- Parse the public response shape into `Job[]` and `TenantResult[]` per the data schema.
- Extract `posted_at` and `updated_at` from native fields when the ATS exposes them.
- Detect `is_recruiter_post` heuristically using a per-ATS rule (the recruiter classifier is a fallback, not the primary signal).
- Surface a `TenantResult.status` even when the response was empty — never silently drop tenants.

Representative ATS shapes (high-level — the contract above holds for
all 51 adapters in `ATS_IDS`, not only these examples):

| ATS | Endpoint shape | Response |
|---|---|---|
| greenhouse | REST GET `boards-api.greenhouse.io/v1/boards/{slug}/jobs` | JSON `{ jobs: [...] }` |
| lever | REST GET `api.lever.co/v0/postings/{slug}` | JSON array |
| ashby | REST GET `api.ashbyhq.com/posting-api/job-board/{slug}` | JSON `{ jobs: [...] }` |
| bamboohr | REST GET `{slug}.bamboohr.com/careers/list` | JSON `{ result: [...] }` |
| workday | POST `{slug}.wd{N}.myworkdayjobs.com/wday/cxs/{slug}/{site}/jobs` with `{ limit, offset }` | JSON paginated; iterate until total reached |
| icims | GET `careers-{slug}.icims.com/sitemap.xml`, then walk job URLs | XML sitemap → individual JSON-LD blobs per job |
| jsonld | GET tenant `metadata.sitemap_url`, walk same-host job URLs | XML sitemap → `schema.org/JobPosting` JSON-LD per page (vendor-agnostic; see specs/gjobsfeed-adapter.md sibling pattern) |
| brassring | GET `sjobs.brassring.com` home (CSRF token + cookie), then POST `…/Search/Ajax/PowerSearchJobs` | two-step; JSON results (title + location, no description) |
| gjobsfeed | one GET of tenant `metadata.feed_url` | RSS 2.0 `xmlns:g="http://base.google.com/ns/1.0"`; every `<item>` a full posting. See [gjobsfeed-adapter](gjobsfeed-adapter.md) |
| amazonjobs / applejobs / tiktokcareers / metacareers | per-company custom endpoint (single-tenant) | JSON; see [ADR-0015](../docs/adr/0015-phase-6-custom-ats-scrapers.md) |
| oraclecloud | GET `{metadata.host}/hcmRestApi/resources/latest/recruitingCEJobRequisitions?onlyData=true&expand=requisitionList…&finder=findReqs;siteNumber={metadata.site},limit,offset` | JSON `{ items: [{ TotalJobsCount, requisitionList: [...] }] }`; paginate via finder offset until total reached |
| jazzhr | GET `{slug}.applytojob.com/apply/` (server-rendered link list), then walk each `/apply/{jobCode}` page | HTML board → `schema.org/JobPosting` JSON-LD per job page (shared jsonld-core) |
| phenom | GET `{metadata.host}/{metadata.locale}/search-results?from=N` (per-tenant vanity host) | HTML embedding `phApp.ddo.eagerLoadRefineSearch` `{ totalHits, data.jobs }`; `?from=N` paginates (10/page) |
| hrmdirect | GET `{slug}.hrmdirect.com/employment/job-openings.php` | HTML table; one `<tr data-req-id>` per role (title/department/city/state) — parsed directly, no detail fetch |
| schoolspring | GET `api.schoolspring.com/api/Jobs/GetJobsCountWithSearch`, then `…/GetPagedJobsWithSearch?page={N}&size={M}` (single-tenant, multi-employer) | JSON `{ success, value: { jobsList } }` envelope; 1-based pages, list rows only (no detail fan-out); per-row `employer` becomes `Job.company` |
| isolvedhire | GET `{slug}.isolvedhire.com/jobs/` (HTML embeds `courierCurrentRouteData` → `domain_id`), then GET `…/core/jobs/{domainId}?getParams={"isInternal":0}` | two-step; JSON `{ success, data: { jobs: [...] } }` — the entire job list in one call, no pagination |
| applicantpool | GET `{slug}.applicantpool.com/jobs/` (HTML embeds `courierCurrentRouteData` → `domain_id`), then GET `…/core/jobs/{domainId}?getParams={"isInternal":0}` | two-step; identical board engine to isolvedhire on the applicantpool.com host; JSON `{ success, data: { jobs: [...] } }` — the entire job list in one call, no pagination |
| applitrack | one GET `www.applitrack.com/{slug}/onlineapp/jobpostings/Output.asp?all=1` | JavaScript `document.write` stream; payloads are unescaped and concatenated into HTML with one `<ul class='postingsList' id='p{id}_'>` block per posting (title/date posted/location) |
| hiringthing | one GET of `{slug}.hiringthing.com/api/rss.xml` | RSS 2.0 (media namespace); every `<item>` a full posting — title, `/job/{id}/{title-slug}` link (numeric id = source identity), location, HTML description in `media:description` CDATA; no dates |
| apploi | GET `ats-integrations.apploi.com/search/jobs/?page=N&size=100&brand={metadata.brand}` | JSON `{ data: [...] }`; rows carry full description + salary. `brand` is a relevance search, not a filter — keep only exact `brand_name` matches; a page with zero exact rows (or a mixed page) ends pagination |
| hirebridge | GET `recruit.hirebridge.com/v3/jobs/list.aspx?cid={cid}` (shared host; tenant slug = numeric cid) | HTML; every open role on one page as location-grouped link lists (title/department under a location heading) — parsed directly, no pagination, no detail fetch |
| taleotbe | GET `{metadata.host}/{metadata.instance}/ats/careers/v2/searchResults?org={slug}&cws={metadata.cws}`, then `&next&rowFrom=N` (10/page) | server-rendered HTML; one `viewJobLink` anchor + location line per role, no detail fetch. Page 1 sets a JSESSIONID that must be echoed on later pages of the same walk (cookie-less pages come back empty); nothing persists across tenants or runs |
| workstream | GET `www.workstream.us/j/{metadata.company_id}/{slug}/positions` (server-rendered link list, `?page=N` paginates 10/page), then walk each linked job page | HTML board → `schema.org/JobPosting` JSON-LD per job page (shared jsonld-core); dead tenants answer 410; a per-IP soft rate limit serves 200s with the JSON-LD stripped, so the fan-out is paced ~1 req/s with a delayed re-fetch on degraded pages |
| careerplug | GET `{slug}.careerplug.com/jobs`, then `?page=N` up to the last page the `.pagination` nav announces | HTML cards (~30/page); each `<a href="/jobs/{id}">` carries title, `ST-City-ZIP` location and post date — parsed directly, no detail fetch |
| jibeapply | GET `{host}/api/jobs?page=N&limit=100` (host = `{slug}.jibeapply.com`, or an optional vanity `metadata.host`) | JSON `{ jobs: [{ data: {…} }], totalCount }`; 1-based `page` + `limit` paginate until totalCount reached; full HTML description ships in the list payload (no detail fetch). Job url = `{host}/jobs/{req_id}` — the payload's `apply_url` is a login deep-link, not a public page |
| hireology | GET `api.hireology.com/v2/public/careers/{slug}?page={n}&page_size=100` | JSON `{ data: [...], count }`; each row carries full HTML description + locations + career-site deep link; paginate `page` until `count` reached |
| pageup | GET `{metadata.host}/{metadata.instance}/{metadata.clientkey}/en/listing/`, then `?page=N` | server-rendered HTML; one or more `job-link` anchors per role (title + `/en/job/{id}/{slug}` deep link) plus a `location` cell — parsed directly, no detail fetch. Composite (host, instance, clientkey) tenancy, slug = `{instance}-{clientkey}` (a clientkey is not globally unique); exposes only an application close-date, so posted_at is never emitted. Walk terminates on the first page with no fresh job ids (the load-more button and facet counts are not reliable end signals) |
| manatal | GET `www.careers-page.com/{slug}` (server-rendered link list of `/{slug}/job/{code}` anchors), then walk each linked job page | HTML board → `schema.org/JobPosting` JSON-LD per job page (shared jsonld-core); no list JSON endpoint, so a bounded N+1 detail fan-out; dead/unknown slug answers a clean 404 |
| rippling | GET `api.rippling.com/platform/api/ats/v1/board/{slug}/jobs` (top-level array, unpaginated), then a bounded concurrency-limited detail GET `…/jobs/{uuid}` per role | JSON array of list rows (uuid, title, department, workLocation, canonical url); the list carries no date/description, so each detail GET adds the HTML `description.role`, `createdOn` post date, `workLocations`, `payRangeDetails` and `companyName`. Detail is enrichment — a failed detail GET keeps the list-only row; a board past the 500-role cap is emitted list-only with a "capped" note |

## Invariants

- A scraper never throws on a single tenant failure; the failure is surfaced via `TenantResult` and the run continues.
- A scraper never returns duplicate `Job.id` within a single run.
- A scraper never emits a `Job` with `tenant_slug` not in the input list.
- `metrics.requests_made >= metrics.requests_failed + metrics.requests_retried + (successes)`.
- The User-Agent is verifiable by the receiving site as identifying this project.

## Test discipline

Every scraper has, at minimum:

1. **Three fixture-replay tests** (large / small / edge tenant) under `tests/fixtures/{ats}.{tenant}.json`, asserted via snapshot.
2. **One property test** asserting the parser is deterministic on the same input.
3. **One retry test** confirming exponential backoff on 5xx and `Retry-After` honored on 429.
4. **One robots.txt test** confirming a `Disallow: /` blocks all requests for that tenant.

Fixtures are re-recorded quarterly (see [ADR-0008](../docs/adr/0008-tdd-95-coverage.md)).

## Rejection cases

- Input with an unknown `ATSId` is rejected at the zod boundary, not silently routed.
- Empty `tenants` array returns an empty `ScrapeOutput` with `requests_made = 0` — not an error.
- A tenant slug containing characters outside `[a-z0-9-]` is rejected before any request is made.
