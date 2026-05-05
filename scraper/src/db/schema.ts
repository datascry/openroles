export const SCHEMA_DDL = `
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
  is_recruiter_post     INTEGER NOT NULL DEFAULT 0,
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
  is_stale              INTEGER NOT NULL DEFAULT 0,
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
`;

export const INDEX_DDL = `
CREATE INDEX idx_jobs_ats_posted_at         ON jobs(ats, posted_at DESC, first_seen_at DESC);
CREATE INDEX idx_jobs_level_posted_at       ON jobs(level, posted_at DESC, first_seen_at DESC);
CREATE INDEX idx_jobs_wt_posted_at          ON jobs(workplace_type, posted_at DESC, first_seen_at DESC);
CREATE INDEX idx_jobs_recruiter_posted_at   ON jobs(is_recruiter_post, posted_at DESC, first_seen_at DESC);
CREATE INDEX idx_jobs_stale_posted_at       ON jobs(is_stale, posted_at DESC, first_seen_at DESC);
CREATE INDEX idx_jobs_company_nocase        ON jobs(company COLLATE NOCASE);
CREATE INDEX idx_jobs_level_rank_posted_at  ON jobs(level_rank, posted_at DESC, first_seen_at DESC);
CREATE INDEX idx_jobs_tenant                ON jobs(ats, tenant_slug);
CREATE INDEX idx_jobs_country_region        ON jobs(location_country, location_region);
CREATE INDEX idx_jobs_first_seen_at         ON jobs(first_seen_at DESC);
-- The "all roles, newest first" homepage sort. Without this index,
-- ORDER BY posted_at DESC forces a temp btree sort over the whole
-- jobs table — hundreds of MB of 1 KiB Range requests to render the
-- first 50 rows over sql.js-httpvfs.
CREATE INDEX idx_jobs_posted_at             ON jobs(posted_at DESC, first_seen_at DESC);
-- Expression index on the 16-char short_id used by the role-detail page
-- (specs/role-detail.md). Without it, role-detail's lookup walked a
-- BETWEEN range over the PRIMARY KEY (50% of the 64-char hex space),
-- which over sql.js-httpvfs translated to dozens of 1 KiB Range requests
-- and a 70-second cold load on production. With this index, the lookup
-- is a single index entry per role — ~3 page reads, sub-second cold.
-- NOT unique: 16 hex chars is 64 bits, so the birthday-collision
-- probability is ~3×10⁻¹⁰ at 10⁵ rows but non-zero. The role-detail
-- query already enforces LIMIT 1; storing both rows is safer than
-- rejecting an insert when a real collision lands.
CREATE INDEX idx_jobs_short_id              ON jobs(substr(id, 1, 16));
`;

// SQLite page size — tuned for sql.js-httpvfs over GitHub Pages.
//
// Trade-off: smaller pages → finer cache granularity at the cost of more
// round trips for the same b-tree walk. With requestChunkSize forced to
// match the page size (see site/src/lib/client-db.ts), a 4096-byte page
// halves the round-trip count vs 1024 for typical role-detail lookups
// while keeping per-fetch latency the same on Fastly's edge.
//
// Cold-load measurement on production (~750k row corpus, 1.4 GB DB):
//   page_size=1024 → 5+ minute cold-start, frequently never resolved
//   page_size=4096 → expected ~10× drop, target sub-30s cold
//
// Empirical confirmation post-deploy lives in the perf bench tracked in
// docs/adr/0010-phase-plan.md (Phase 14+ rolling perf table).
export const PAGE_SIZE_PRAGMA = "PRAGMA page_size = 4096;";
export const VACUUM_STMT = "VACUUM;";
export const FTS_OPTIMIZE_STMT = "INSERT INTO jobs_fts(jobs_fts) VALUES ('optimize');";
