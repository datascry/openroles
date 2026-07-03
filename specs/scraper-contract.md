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
all 37 adapters in `ATS_IDS`, not only these examples):

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
| hireology | GET `api.hireology.com/v2/public/careers/{slug}?page={n}&page_size=100` | JSON `{ data: [...], count }`; each row carries full HTML description + locations + career-site deep link; paginate `page` until `count` reached |

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
