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
CREATE INDEX idx_jobs_ats_posted_at         ON jobs(ats, posted_at DESC);
CREATE INDEX idx_jobs_level_ats             ON jobs(level, ats);
CREATE INDEX idx_jobs_level_rank            ON jobs(level_rank);
CREATE INDEX idx_jobs_workplace_type        ON jobs(workplace_type);
CREATE INDEX idx_jobs_tenant                ON jobs(ats, tenant_slug);
CREATE INDEX idx_jobs_first_seen_at         ON jobs(first_seen_at DESC);
CREATE INDEX idx_jobs_country_region        ON jobs(location_country, location_region);
CREATE INDEX idx_jobs_is_stale              ON jobs(is_stale);
-- Covers the "newest by posted_at" sort the UI exposes. Without this
-- index, ORDER BY posted_at DESC, first_seen_at DESC forces SQLite to
-- read every page in the jobs table and sort them in a temp btree.
-- Over sql.js-httpvfs that translates to hundreds of MB of 1 KiB
-- page fetches to render the first 50 rows.
CREATE INDEX idx_jobs_posted_at             ON jobs(posted_at DESC, first_seen_at DESC);
`;

export const PAGE_SIZE_PRAGMA = "PRAGMA page_size = 1024;";
export const VACUUM_STMT = "VACUUM;";
export const FTS_OPTIMIZE_STMT = "INSERT INTO jobs_fts(jobs_fts) VALUES ('optimize');";
