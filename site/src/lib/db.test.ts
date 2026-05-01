import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Job, jobId } from "@openroles/shared";
import {
  FTS_OPTIMIZE_STMT,
  INDEX_DDL,
  PAGE_SIZE_PRAGMA,
  SCHEMA_DDL,
  VACUUM_STMT,
} from "../../../scraper/src/db/schema.ts";
import {
  dataDirIsPopulated,
  openSiteDb,
  selectAllJobsForStatic,
  selectFeedJobs,
  selectTenantJobs,
  selectTenants,
} from "./db.ts";

const OBSERVED_AT = "2026-04-26T00:00:00Z";

function makeJob(overrides: Partial<Job> = {}): Job {
  const base = {
    ats: "greenhouse" as const,
    tenant_slug: "stripe",
    source_id: "1",
    title: "Senior Software Engineer",
    company: "Stripe",
    url: "https://example.com/1",
  };
  const m = { ...base, ...overrides };
  return {
    id: jobId({ ats: m.ats, tenant_slug: m.tenant_slug, source_id: m.source_id, url: m.url }),
    ats: m.ats,
    tenant_slug: m.tenant_slug,
    source_id: m.source_id,
    title: m.title,
    company: m.company,
    level: null,
    level_rank: null,
    workplace_type: null,
    is_recruiter_post: false,
    first_seen_at: OBSERVED_AT,
    last_seen_at: OBSERVED_AT,
    url: m.url,
    ...overrides,
  };
}

const dbs: Database[] = [];
afterEach(() => {
  for (const d of dbs) d.close();
  dbs.length = 0;
});

function fresh(
  jobs: Job[],
  tenants: Array<{ ats: string; slug: string; status?: string }> = [],
): Database {
  const db = new Database(":memory:");
  db.exec(PAGE_SIZE_PRAGMA);
  db.exec(SCHEMA_DDL);
  db.exec(INDEX_DDL);
  const insertJob = db.prepare(
    "INSERT INTO jobs (id, ats, tenant_slug, source_id, title, company, level, level_rank, workplace_type, is_recruiter_post, posted_at, first_seen_at, last_seen_at, url) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  );
  for (const j of jobs) {
    insertJob.run(
      j.id,
      j.ats,
      j.tenant_slug,
      j.source_id,
      j.title,
      j.company,
      j.level,
      j.level_rank,
      j.workplace_type,
      j.is_recruiter_post ? 1 : 0,
      j.posted_at ?? null,
      j.first_seen_at,
      j.last_seen_at,
      j.url,
    );
  }
  const insertTenant = db.prepare(
    "INSERT INTO tenants (ats, slug, status, last_probed_at) VALUES (?, ?, ?, ?)",
  );
  for (const t of tenants) {
    insertTenant.run(t.ats, t.slug, t.status ?? "live", OBSERVED_AT);
  }
  db.exec(VACUUM_STMT);
  db.exec(FTS_OPTIMIZE_STMT);
  dbs.push(db);
  return db;
}

describe("selectFeedJobs", () => {
  it("returns jobs sorted by posted_at DESC", () => {
    const db = fresh([
      makeJob({
        source_id: "1",
        url: "https://example.com/1",
        posted_at: "2026-04-22T00:00:00Z",
      }),
      makeJob({
        source_id: "2",
        url: "https://example.com/2",
        posted_at: "2026-04-25T00:00:00Z",
      }),
    ]);
    const jobs = selectFeedJobs(db, {});
    expect(jobs.map((j) => j.source_id)).toEqual(["2", "1"]);
  });

  it("filters by ats and by level", () => {
    const db = fresh([
      makeJob({ source_id: "1", url: "https://example.com/1", ats: "greenhouse" }),
      makeJob({ source_id: "2", url: "https://example.com/2", ats: "lever" }),
      makeJob({
        source_id: "3",
        url: "https://example.com/3",
        ats: "greenhouse",
        level: "senior",
        level_rank: 4,
      }),
    ]);
    expect(selectFeedJobs(db, { ats: "lever" })).toHaveLength(1);
    expect(selectFeedJobs(db, { level: "senior" })).toHaveLength(1);
  });

  it("respects the limit", () => {
    const db = fresh(
      Array.from({ length: 10 }, (_, i) =>
        makeJob({ source_id: String(i), url: `https://example.com/${i}` }),
      ),
    );
    expect(selectFeedJobs(db, {}, 3)).toHaveLength(3);
  });
});

describe("selectTenants", () => {
  it("aggregates tenant + job_count", () => {
    const db = fresh(
      [
        makeJob({ source_id: "1", url: "https://example.com/1", tenant_slug: "stripe" }),
        makeJob({ source_id: "2", url: "https://example.com/2", tenant_slug: "stripe" }),
        makeJob({
          source_id: "3",
          url: "https://example.com/3",
          tenant_slug: "anthropic",
          ats: "lever",
        }),
      ],
      [
        { ats: "greenhouse", slug: "stripe" },
        { ats: "lever", slug: "anthropic" },
        { ats: "ashby", slug: "lonely" },
      ],
    );
    const rows = selectTenants(db);
    expect(rows).toHaveLength(3);
    const stripe = rows.find((r) => r.slug === "stripe");
    expect(stripe?.job_count).toBe(2);
    const lonely = rows.find((r) => r.slug === "lonely");
    expect(lonely?.job_count).toBe(0);
  });
});

describe("selectAllJobsForStatic", () => {
  it("returns every job in the database, no LIMIT", () => {
    const jobs = Array.from({ length: 5 }, (_, i) =>
      makeJob({ source_id: String(i), url: `https://example.com/${i}` }),
    );
    const db = fresh(jobs);
    const out = selectAllJobsForStatic(db);
    expect(out).toHaveLength(5);
  });

  it("returns rows ordered newest-first by posted_at then first_seen_at then id", () => {
    const db = fresh([
      makeJob({
        source_id: "old",
        url: "https://example.com/old",
        first_seen_at: "2026-01-01T00:00:00Z",
      }),
      makeJob({
        source_id: "new",
        url: "https://example.com/new",
        first_seen_at: "2026-04-26T00:00:00Z",
      }),
    ]);
    const out = selectAllJobsForStatic(db);
    expect(out[0]?.source_id).toBe("new");
    expect(out[1]?.source_id).toBe("old");
  });

  it("returns an empty array when the jobs table is empty", () => {
    const db = fresh([]);
    expect(selectAllJobsForStatic(db)).toEqual([]);
  });
});

describe("selectTenantJobs", () => {
  it("returns jobs for a single (ats, slug)", () => {
    const db = fresh([
      makeJob({ source_id: "1", url: "https://example.com/1", tenant_slug: "stripe" }),
      makeJob({
        source_id: "2",
        url: "https://example.com/2",
        ats: "lever",
        tenant_slug: "stripe",
      }),
    ]);
    expect(selectTenantJobs(db, "greenhouse", "stripe")).toHaveLength(1);
  });
});

describe("openSiteDb / dataDirIsPopulated", () => {
  it("returns false when the directory does not exist", () => {
    expect(dataDirIsPopulated("/tmp/openroles-does-not-exist-xyz")).toBe(false);
  });

  it("returns false when the manifest is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "openroles-db-"));
    expect(dataDirIsPopulated(dir)).toBe(false);
  });

  it("opens a real on-disk db via the manifest", () => {
    const dir = mkdtempSync(join(tmpdir(), "openroles-db-"));
    const dbPath = join(dir, "jobs.abc1234.sqlite");
    const db = new Database(dbPath);
    db.exec(PAGE_SIZE_PRAGMA);
    db.exec(SCHEMA_DDL);
    db.close();
    writeFileSync(
      join(dir, "manifest.json"),
      JSON.stringify({
        schema_version: "1.0.0",
        built_at: OBSERVED_AT,
        short_sha: "abc1234",
        db_filename: "jobs.abc1234.sqlite",
        total_rows: 0,
        ats_counts: {
          greenhouse: 0,
          lever: 0,
          ashby: 0,
          bamboohr: 0,
          workday: 0,
          icims: 0,
        },
        tenants_total: 0,
        tenants_live: 0,
      }),
    );
    expect(dataDirIsPopulated(dir)).toBe(true);
    const site = openSiteDb(dir);
    expect(site.manifest.short_sha).toBe("abc1234");
    site.close();
  });

  it("throws when manifest references a missing sqlite file", () => {
    const dir = mkdtempSync(join(tmpdir(), "openroles-db-"));
    writeFileSync(
      join(dir, "manifest.json"),
      JSON.stringify({
        schema_version: "1.0.0",
        built_at: OBSERVED_AT,
        short_sha: "abc1234",
        db_filename: "jobs.does-not-exist.sqlite",
        total_rows: 0,
        ats_counts: {
          greenhouse: 0,
          lever: 0,
          ashby: 0,
          bamboohr: 0,
          workday: 0,
          icims: 0,
        },
        tenants_total: 0,
        tenants_live: 0,
      }),
    );
    expect(() => openSiteDb(dir)).toThrow();
  });

  it("throws when the data dir has no manifest", () => {
    const dir = mkdtempSync(join(tmpdir(), "openroles-db-"));
    expect(() => openSiteDb(dir)).toThrow();
  });
});
