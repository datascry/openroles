import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { type Job, jobId } from "@openroles/shared";
import {
  FTS_OPTIMIZE_STMT,
  INDEX_DDL,
  PAGE_SIZE_PRAGMA,
  SCHEMA_DDL,
  VACUUM_STMT,
} from "../../../scraper/src/db/schema.ts";
import { buildFilterCountQuery, buildFilterQuery } from "./filter-sql.ts";
import { DEFAULT_FILTER_STATE } from "./filter-state.ts";

const OBSERVED_AT = "2026-04-26T00:00:00Z";

function makeJob(overrides: Partial<Job> = {}): Job {
  const base = {
    ats: "greenhouse" as const,
    tenant_slug: "stripe",
    source_id: "1",
    title: "Senior Engineer",
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

function fresh(jobs: Job[]): Database {
  const db = new Database(":memory:");
  db.exec(PAGE_SIZE_PRAGMA);
  db.exec(SCHEMA_DDL);
  db.exec(INDEX_DDL);
  const insert = db.prepare(
    "INSERT INTO jobs (id, ats, tenant_slug, source_id, title, company, level, level_rank, workplace_type, is_recruiter_post, location_text, location_country, location_region, compensation_min, posted_at, first_seen_at, last_seen_at, url) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  );
  for (const j of jobs) {
    insert.run(
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
      j.location_text ?? null,
      j.location_country ?? null,
      j.location_region ?? null,
      j.compensation_min ?? null,
      j.posted_at ?? null,
      j.first_seen_at,
      j.last_seen_at,
      j.url,
    );
  }
  db.exec(VACUUM_STMT);
  db.exec(FTS_OPTIMIZE_STMT);
  dbs.push(db);
  return db;
}

describe("buildFilterQuery", () => {
  it("returns the unfiltered page on default state", () => {
    const db = fresh([
      makeJob({ source_id: "1", url: "https://example.com/1" }),
      makeJob({ source_id: "2", url: "https://example.com/2" }),
    ]);
    const plan = buildFilterQuery(DEFAULT_FILTER_STATE);
    const rows = db.query(plan.sql).all(...plan.params);
    expect(rows).toHaveLength(2);
  });

  it("filters by ats multi-select", () => {
    const db = fresh([
      makeJob({ source_id: "1", url: "https://example.com/1", ats: "greenhouse" }),
      makeJob({ source_id: "2", url: "https://example.com/2", ats: "lever" }),
      makeJob({ source_id: "3", url: "https://example.com/3", ats: "ashby" }),
    ]);
    const plan = buildFilterQuery({ ...DEFAULT_FILTER_STATE, ats: ["greenhouse", "lever"] });
    const rows = db.query(plan.sql).all(...plan.params) as Array<{ ats: string }>;
    expect(rows.map((r) => r.ats).sort()).toEqual(["greenhouse", "lever"]);
  });

  it("filters by level multi-select with level_rank ordering", () => {
    const db = fresh([
      makeJob({
        source_id: "1",
        url: "https://example.com/1",
        title: "Junior Engineer",
        level: "junior",
        level_rank: 2,
      }),
      makeJob({
        source_id: "2",
        url: "https://example.com/2",
        title: "Senior Engineer",
        level: "senior",
        level_rank: 4,
      }),
      makeJob({
        source_id: "3",
        url: "https://example.com/3",
        title: "Staff Engineer",
        level: "staff",
        level_rank: 5,
      }),
    ]);
    const plan = buildFilterQuery({
      ...DEFAULT_FILTER_STATE,
      level: ["senior", "staff"],
      sort: "level:asc",
    });
    const rows = db.query(plan.sql).all(...plan.params) as Array<{ level: string }>;
    expect(rows.map((r) => r.level)).toEqual(["senior", "staff"]);
  });

  it("filters by FTS5 phrase, escaping double-quotes safely", () => {
    const db = fresh([
      makeJob({
        source_id: "1",
        url: "https://example.com/1",
        title: 'A "quoted" thing',
      }),
      makeJob({ source_id: "2", url: "https://example.com/2", title: "unrelated" }),
    ]);
    const plan = buildFilterQuery({ ...DEFAULT_FILTER_STATE, q: '"quoted"' });
    const rows = db.query(plan.sql).all(...plan.params);
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  it("filters by location:value via case-insensitive LIKE on location_text", () => {
    const db = fresh([
      makeJob({
        source_id: "1",
        url: "https://example.com/1",
        title: "Engineer",
        company: "Stripe",
        location_text: "San Francisco, CA · Remote",
      }),
      makeJob({
        source_id: "2",
        url: "https://example.com/2",
        title: "Engineer",
        company: "Vercel",
        location_text: "Worldwide",
      }),
    ]);
    const plan = buildFilterQuery({ ...DEFAULT_FILTER_STATE, q: "location:remote" });
    const rows = db.query(plan.sql).all(...plan.params) as Array<{ company: string }>;
    expect(rows.map((r) => r.company)).toEqual(["Stripe"]);
  });

  it("AND-joins FTS-token + location-token from a single search input", () => {
    const db = fresh([
      makeJob({
        source_id: "1",
        url: "https://example.com/1",
        title: "Senior Engineer",
        company: "Stripe",
        location_text: "Remote · US",
      }),
      makeJob({
        source_id: "2",
        url: "https://example.com/2",
        title: "Senior Engineer",
        company: "Acme",
        location_text: "London, UK",
      }),
      makeJob({
        source_id: "3",
        url: "https://example.com/3",
        title: "Designer",
        company: "Acme",
        location_text: "Remote · UK",
      }),
    ]);
    const plan = buildFilterQuery({
      ...DEFAULT_FILTER_STATE,
      q: "title:engineer location:remote",
    });
    const rows = db.query(plan.sql).all(...plan.params) as Array<{ company: string }>;
    expect(rows.map((r) => r.company).sort()).toEqual(["Stripe"]);
  });

  it("escapes LIKE wildcards in location values so user input cannot match-all", () => {
    const db = fresh([
      makeJob({
        source_id: "1",
        url: "https://example.com/1",
        title: "Engineer",
        company: "A",
        location_text: "Bonus 50% remote",
      }),
      makeJob({
        source_id: "2",
        url: "https://example.com/2",
        title: "Engineer",
        company: "B",
        location_text: "London",
      }),
    ]);
    // Without LIKE escape, `%` would be a wildcard and match everything.
    // With escape, only the literal "50%" substring matches.
    const plan = buildFilterQuery({ ...DEFAULT_FILTER_STATE, q: "location:50%" });
    const rows = db.query(plan.sql).all(...plan.params) as Array<{ company: string }>;
    expect(rows.map((r) => r.company)).toEqual(["A"]);
  });

  it("filters by workplace_type multi-select", () => {
    const db = fresh([
      makeJob({ source_id: "1", url: "https://example.com/1", workplace_type: "remote" }),
      makeJob({ source_id: "2", url: "https://example.com/2", workplace_type: "hybrid" }),
      makeJob({ source_id: "3", url: "https://example.com/3", workplace_type: "onsite" }),
    ]);
    const plan = buildFilterQuery({ ...DEFAULT_FILTER_STATE, wt: ["remote", "hybrid"] });
    const rows = db.query(plan.sql).all(...plan.params) as Array<{ workplace_type: string }>;
    expect(rows.map((r) => r.workplace_type).sort()).toEqual(["hybrid", "remote"]);
  });

  it("supports every sort option", () => {
    const db = fresh([
      makeJob({
        source_id: "1",
        url: "https://example.com/1",
        company: "Aaa",
        posted_at: "2026-04-20T00:00:00Z",
      }),
      makeJob({
        source_id: "2",
        url: "https://example.com/2",
        company: "Bbb",
        posted_at: "2026-04-22T00:00:00Z",
      }),
    ]);
    const sorts = [
      "posted_at:desc",
      "posted_at:asc",
      "first_seen:desc",
      "first_seen:asc",
      "company:asc",
      "company:desc",
      "level:asc",
      "level:desc",
    ] as const;
    for (const sort of sorts) {
      const plan = buildFilterQuery({ ...DEFAULT_FILTER_STATE, sort });
      expect(() => db.query(plan.sql).all(...plan.params)).not.toThrow();
    }
  });

  it("hides recruiter posts when hideRecruiter is set", () => {
    const db = fresh([
      makeJob({ source_id: "1", url: "https://example.com/1", is_recruiter_post: false }),
      makeJob({ source_id: "2", url: "https://example.com/2", is_recruiter_post: true }),
    ]);
    const plan = buildFilterQuery({ ...DEFAULT_FILTER_STATE, hideRecruiter: true });
    const rows = db.query(plan.sql).all(...plan.params);
    expect(rows).toHaveLength(1);
  });

  it("filters by compensation_min", () => {
    const db = fresh([
      makeJob({ source_id: "1", url: "https://example.com/1", compensation_min: 5000 }),
      makeJob({ source_id: "2", url: "https://example.com/2", compensation_min: 25000 }),
      makeJob({ source_id: "3", url: "https://example.com/3" }),
    ]);
    const plan = buildFilterQuery({ ...DEFAULT_FILTER_STATE, minComp: 10000 });
    const rows = db.query(plan.sql).all(...plan.params);
    expect(rows).toHaveLength(1);
  });

  it("filters by country and region", () => {
    const db = fresh([
      makeJob({
        source_id: "1",
        url: "https://example.com/1",
        location_country: "US",
        location_region: "CA",
      }),
      makeJob({
        source_id: "2",
        url: "https://example.com/2",
        location_country: "US",
        location_region: "NY",
      }),
      makeJob({
        source_id: "3",
        url: "https://example.com/3",
        location_country: "GB",
        location_region: "London",
      }),
    ]);
    const plan = buildFilterQuery({ ...DEFAULT_FILTER_STATE, country: "US", region: "CA" });
    const rows = db.query(plan.sql).all(...plan.params);
    expect(rows).toHaveLength(1);
  });

  it("filters by since window", () => {
    const recent = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const db = fresh([
      makeJob({ source_id: "1", url: "https://example.com/1", posted_at: recent }),
      makeJob({ source_id: "2", url: "https://example.com/2", posted_at: old }),
    ]);
    const plan = buildFilterQuery({ ...DEFAULT_FILTER_STATE, since: "24h" });
    const rows = db.query(plan.sql).all(...plan.params);
    expect(rows).toHaveLength(1);
  });

  it("paginates with the requested page size", () => {
    const db = fresh(
      Array.from({ length: 7 }, (_, i) =>
        makeJob({ source_id: String(i), url: `https://example.com/${i}` }),
      ),
    );
    const planP1 = buildFilterQuery({ ...DEFAULT_FILTER_STATE, page: 1 }, 3);
    const planP2 = buildFilterQuery({ ...DEFAULT_FILTER_STATE, page: 2 }, 3);
    const p1 = db.query(planP1.sql).all(...planP1.params);
    const p2 = db.query(planP2.sql).all(...planP2.params);
    expect(p1).toHaveLength(3);
    expect(p2).toHaveLength(3);
  });
});

describe("buildFilterCountQuery", () => {
  it("returns the total count for the same filter shape", () => {
    const db = fresh(
      Array.from({ length: 5 }, (_, i) =>
        makeJob({ source_id: String(i), url: `https://example.com/${i}`, ats: "greenhouse" }),
      ).concat(
        Array.from({ length: 3 }, (_, i) =>
          makeJob({
            source_id: `lever-${i}`,
            url: `https://example.com/lever-${i}`,
            ats: "lever",
          }),
        ),
      ),
    );
    const plan = buildFilterCountQuery({ ...DEFAULT_FILTER_STATE, ats: ["greenhouse"] });
    const row = db.query(plan.sql).get(...plan.params) as { c: number };
    expect(row.c).toBe(5);
  });
});

describe("SQL injection safety", () => {
  it("treats user input as bind parameters, never string-concatenated", () => {
    const db = fresh([makeJob()]);
    const plan = buildFilterQuery({
      ...DEFAULT_FILTER_STATE,
      q: "'; DROP TABLE jobs; --",
    });
    db.query(plan.sql).all(...plan.params);
    const stillThere = (db.query("SELECT COUNT(*) AS c FROM jobs").get() as { c: number }).c;
    expect(stillThere).toBe(1);
  });
});
