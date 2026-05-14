# Spec: Data schema

**Version**: 4.0.0 (matches `SCHEMA_VERSION` in [`shared/src/index.ts`](../shared/src/index.ts); bump major on backward-incompatible changes)

The on-disk schema is the single source of truth shared by the scraper, the build-db step, and the site. zod schemas in `shared/src/schema/` validate at every boundary.

## Type-level shapes

### `ATSId`

```typescript
type ATSId =
  | "greenhouse" | "lever" | "ashby" | "bamboohr" | "workday" | "icims"
  | "recruitee" | "breezy" | "personio" | "workable" | "teamtailor"
  | "smartrecruiters" | "csod" | "taleo" | "ultipro" | "jobvite"
  | "zohorecruit" | "talentlyft" | "pinpointhq" | "applicantpro"
  | "applicantstack" | "homerun" | "factorial" | "eightfold"
  | "successfactors"
  | "amazonjobs" | "applejobs" | "tiktokcareers" | "metacareers"
  | "jsonld"
  | "brassring";
```

Canonical declaration in [`shared/src/schema/ats.ts`](../shared/src/schema/ats.ts) (`ATS_IDS`). New entries append to preserve the stable hash ordering used by `ATS_RANK`. Adding or removing an `ATSId` is a **major** schema bump because `ATSCountsSchema` (in `shared/src/schema/manifest.ts`) is `.strict()`: a reader on the older schema rejects a manifest carrying an `ats_counts.<new-key> = 0` entry with `Unrecognized key`. The 2.0.0 → 3.0.0 → 4.0.0 sequence (phenom revert / jsonld add / brassring add) all share this rule.

### `Level`

```typescript
type Level = "intern" | "entry" | "junior" | "mid" | "senior" | "staff" | "principal" | "lead" | "manager" | "director" | null;
```

`null` means "could not be classified with confidence." The classifier never throws.

Sortable rank for the filter UI is derived from the enum order:

```typescript
const LEVEL_RANK: Record<NonNullable<Level>, number> = {
  intern: 0, entry: 1, junior: 2, mid: 3, senior: 4,
  staff: 5, principal: 6, lead: 7, manager: 8, director: 9,
};
```

Stored as `level_rank INTEGER` alongside `level` in the SQLite `jobs` table so `ORDER BY level_rank` gives the expected progression.

### `WorkplaceType`

```typescript
type WorkplaceType = "remote" | "hybrid" | "onsite" | null;
```

`null` when the source ATS does not expose a structured workplace-type field.

### `Tenant`

```typescript
interface Tenant {
  ats: ATSId;
  slug: string;             // ATS-internal slug, e.g. "stripe" or "airbnb"
  display_name?: string;    // optional friendly name; falls back to slug
  homepage_url?: string;    // optional canonical company homepage
  status: "live" | "transient_failure" | "dead";
  last_probed_at: string;   // ISO 8601 UTC
  metadata?: Record<string, string>;
}
```

`metadata` is an optional per-ATS bag of strings the harvester captures
alongside the slug. Keys are constrained to `[a-zA-Z0-9_-]{1,64}` and
values to ASCII strings of length ≤ 256 so they round-trip safely
through the CSV / SQLite encoding boundary.

ATS-specific keys today:

| ATS       | Keys              | Source / shape                                                                 |
| --------- | ----------------- | ------------------------------------------------------------------------------ |
| workday   | `host`, `site`    | `host` from CDX (`*.wd<n>.myworkdayjobs.com`); `site` auto-discovered from the |
|           |                   | tenant's `/robots.txt` (preferring the first `Allow:` directive, falling back  |
|           |                   | to the `Sitemap:` URL). When `site` is absent the workday scraper falls back   |
|           |                   | to the hardcoded External → Careers → External_Career_Site → External_Site     |
|           |                   | chain. Schema 1.4.0 formalises the discovery channel; older tenant files       |
|           |                   | without `site` continue to read cleanly.                                       |
| ultipro   | `board_id`        | `board_id` is the per-tenant GUID embedded in the public board URL.            |
| successfactors | `host`       | `host` is the per-tenant SuccessFactors regional datacenter (`career{N}.successfactors.{tld}`). |
|           |                   | Harvest captures it from CDX URL parameters; missing metadata falls back to the |
|           |                   | most common public cluster (`career4.successfactors.com`).                      |
| jsonld    | `sitemap_url`     | Full `https://` URL to the tenant's sitemap.xml (or sitemapindex). The adapter |
|           |                   | walks the sitemap, filters per-job URLs by same-host + `/job(s)/` path, fetches |
|           |                   | each, and extracts `schema.org/JobPosting` JSON-LD. Hand-seeded — not             |
|           |                   | discoverable from CDX. Vendor-agnostic; first verified seeds are TalentBrew-     |
|           |                   | hosted brands but any future tenant that emits JobPosting JSON-LD plugs in.     |
| brassring | `partnerid`, `siteid` | Both numeric IDs (digit-only strings) that select the tenant within the |
|           |                   | shared `sjobs.brassring.com` host. The adapter does a two-step home → API flow: |
|           |                   | GET the home page to capture `__RequestVerificationToken` + Set-Cookie session, |
|           |                   | then POST `/TgNewUI/Search/Ajax/PowerSearchJobs` with the RFT header + cookies. |
|           |                   | Search-results endpoint omits description; title + location only.               |

### `Job`

```typescript
interface Job {
  // Identity
  id: string;               // SHA-256 hash of (ats, slug, source_id, url) — stable across crawls
  ats: ATSId;
  tenant_slug: string;
  source_id: string;        // ATS-native job ID (ATS opaque)

  // Display
  title: string;
  company: string;          // resolved from Tenant.display_name or slug
  description_excerpt?: string; // first ~280 chars of the job body, plain text

  // Classification
  level: Level;
  level_rank: number | null;     // derived from Level via LEVEL_RANK; null when level is null
  workplace_type: WorkplaceType;
  is_recruiter_post: boolean;

  // Location
  location_text?: string;   // raw "City, State" or "Remote, US" string
  location_country?: string; // ISO 3166-1 alpha-2 when extractable
  location_region?: string; // first-level subdivision when extractable

  // Compensation (optional; only when ATS exposes structured fields)
  compensation_min?: number;
  compensation_max?: number;
  compensation_currency?: string; // ISO 4217

  // Department / category (when available)
  department?: string;

  // Timestamps (all ISO 8601 UTC)
  posted_at?: string;       // when the ATS reports the job opened
  updated_at?: string;      // when the ATS last modified the listing
  first_seen_at: string;    // when our crawl first observed it
  last_seen_at: string;     // when our crawl last observed it

  // Source link
  url: string;              // canonical apply URL on the ATS
}
```

### `Manifest`

```typescript
interface Manifest {
  schema_version: string;   // e.g. "1.0.0"
  built_at: string;         // ISO 8601 UTC of the build
  short_sha: string;        // git short SHA of the build commit
  db_filename: string;      // e.g. "jobs.a3f2b1.sqlite.gz"
  total_rows: number;
  ats_counts: Record<ATSId, number>;
  tenants_total: number;
  tenants_live: number;
}
```

## Storage layer (SQLite)

Tables produced by `scraper/src/db/build-db.ts`:

```sql
CREATE TABLE jobs (
  id                    TEXT PRIMARY KEY,
  ats                   TEXT NOT NULL,
  tenant_slug           TEXT NOT NULL,
  source_id             TEXT NOT NULL,
  title                 TEXT NOT NULL,
  company               TEXT NOT NULL,
  description_excerpt   TEXT,
  level                 TEXT,
  level_rank            INTEGER,
  workplace_type        TEXT,
  is_recruiter_post     INTEGER NOT NULL DEFAULT 0,  -- boolean
  location_text         TEXT,
  location_country      TEXT,
  location_region       TEXT,
  compensation_min      INTEGER,
  compensation_max      INTEGER,
  compensation_currency TEXT,
  department            TEXT,
  posted_at             TEXT,
  updated_at            TEXT,
  first_seen_at         TEXT NOT NULL,
  last_seen_at          TEXT NOT NULL,
  url                   TEXT NOT NULL UNIQUE
);

CREATE TABLE tenants (
  ats                   TEXT NOT NULL,
  slug                  TEXT NOT NULL,
  display_name          TEXT,
  homepage_url          TEXT,
  status                TEXT NOT NULL,
  last_probed_at        TEXT NOT NULL,
  PRIMARY KEY (ats, slug)
);

CREATE TABLE crawls (
  build_short_sha       TEXT PRIMARY KEY,
  built_at              TEXT NOT NULL,
  total_rows            INTEGER NOT NULL,
  notes                 TEXT
);

CREATE VIRTUAL TABLE jobs_fts USING fts5(
  title, company, description_excerpt,
  content='jobs', content_rowid='rowid',
  tokenize='porter unicode61'
);

-- Triggers keep FTS in sync with jobs.
CREATE TRIGGER jobs_fts_insert AFTER INSERT ON jobs BEGIN
  INSERT INTO jobs_fts(rowid, title, company, description_excerpt)
  VALUES (new.rowid, new.title, new.company, new.description_excerpt);
END;
CREATE TRIGGER jobs_fts_delete AFTER DELETE ON jobs BEGIN
  INSERT INTO jobs_fts(jobs_fts, rowid, title, company, description_excerpt)
  VALUES ('delete', old.rowid, old.title, old.company, old.description_excerpt);
END;
CREATE TRIGGER jobs_fts_update AFTER UPDATE ON jobs BEGIN
  INSERT INTO jobs_fts(jobs_fts, rowid, title, company, description_excerpt)
  VALUES ('delete', old.rowid, old.title, old.company, old.description_excerpt);
  INSERT INTO jobs_fts(rowid, title, company, description_excerpt)
  VALUES (new.rowid, new.title, new.company, new.description_excerpt);
END;
```

### Indexes

Covering indexes for every WHERE / ORDER BY shape the client uses:

```sql
CREATE INDEX idx_jobs_ats_posted_at         ON jobs(ats, posted_at DESC);
CREATE INDEX idx_jobs_level_ats             ON jobs(level, ats);
CREATE INDEX idx_jobs_level_rank            ON jobs(level_rank);
CREATE INDEX idx_jobs_workplace_type        ON jobs(workplace_type);
CREATE INDEX idx_jobs_tenant                ON jobs(ats, tenant_slug);
CREATE INDEX idx_jobs_first_seen_at         ON jobs(first_seen_at DESC);
CREATE INDEX idx_jobs_country_region        ON jobs(location_country, location_region);
```

### Final build steps

```sql
PRAGMA page_size = 1024;       -- legacy from the sql.js-httpvfs era
                               -- (ADR-0002, superseded by ADR-0012);
                               -- preserved for the parquet side artifact
                               -- and small-file VACUUM efficiency
VACUUM;
INSERT INTO jobs_fts(jobs_fts) VALUES ('optimize');  -- compact FTS5
                                                     -- segments; FTS5 is
                                                     -- still used at
                                                     -- build-time for
                                                     -- drift queries,
                                                     -- not at runtime
```

> The build-time SQLite is not deployed (ADR-0012). The runtime data
> path is the slim-index — 38 chunked `.json.gz` files derived from
> the same row set, emitted by `db/slim-index.ts`. The schema below is
> still authoritative for the build-time DB and the parquet side
> artifact.

`page_size = 1024` must run **before** any data is written to the file; `VACUUM` enforces it after the schema is created.

## Invariants

- `Job.id` is deterministic across builds: same `(ats, tenant_slug, source_id, url)` always hashes to the same id.
- `Job.url` is unique; FTS rows have 1:1 correspondence with `jobs` rows.
- `Manifest.total_rows` equals `SELECT COUNT(*) FROM jobs`.
- `Manifest.ats_counts[ats]` equals `SELECT COUNT(*) FROM jobs WHERE ats = ?` for each `ATSId`.
- `Tenant.last_probed_at` is updated atomically with `Tenant.status` — never a stale status.
- Numeric fields (`compensation_min`, `compensation_max`) are integers in the smallest currency unit (cents for USD); never strings.

## Rejection cases

The zod schemas reject:

- Empty or whitespace-only `title`, `company`, `id`, `url`.
- `posted_at` later than `last_seen_at` or `built_at`.
- `compensation_min > compensation_max`.
- `compensation_currency` not in ISO 4217.
- `ats` outside the closed `ATSId` set.
- `level` outside the closed `Level` set.

## Canonical example

```json
{
  "id": "8b7f2c0e1d6a4f3b9c5e7a8f1b2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d",
  "ats": "greenhouse",
  "tenant_slug": "stripe",
  "source_id": "5839271",
  "title": "Senior Software Engineer, Payments",
  "company": "Stripe",
  "description_excerpt": "Build the systems that move money for millions of businesses worldwide…",
  "level": "senior",
  "level_rank": 4,
  "workplace_type": "hybrid",
  "is_recruiter_post": false,
  "location_text": "San Francisco, CA",
  "location_country": "US",
  "location_region": "CA",
  "compensation_min": null,
  "compensation_max": null,
  "compensation_currency": null,
  "department": "Engineering",
  "posted_at": "2026-04-22T17:14:00Z",
  "updated_at": "2026-04-25T09:03:00Z",
  "first_seen_at": "2026-04-22T18:00:00Z",
  "last_seen_at": "2026-04-26T00:00:00Z",
  "url": "https://boards.greenhouse.io/stripe/jobs/5839271"
}
```
