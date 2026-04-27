import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { ATS_IDS, type Job, jobId, type ScrapeOutput, type Tenant } from "@openroles/shared";
import fc from "fast-check";
import { buildDb, classifyJob } from "./build-db.ts";

const OBSERVED_AT = "2026-04-26T00:00:00Z";

function makeJob(overrides: Partial<Job> = {}): Job {
  const base = {
    ats: "greenhouse" as const,
    tenant_slug: "stripe",
    source_id: "1",
    title: "Senior Software Engineer",
    company: "Stripe",
    url: "https://boards.greenhouse.io/stripe/jobs/1",
  };
  const merged = { ...base, ...overrides };
  return {
    id: jobId({
      ats: merged.ats,
      tenant_slug: merged.tenant_slug,
      source_id: merged.source_id,
      url: merged.url,
    }),
    ats: merged.ats,
    tenant_slug: merged.tenant_slug,
    source_id: merged.source_id,
    title: merged.title,
    company: merged.company,
    level: null,
    level_rank: null,
    workplace_type: null,
    is_recruiter_post: false,
    first_seen_at: OBSERVED_AT,
    last_seen_at: OBSERVED_AT,
    url: merged.url,
    ...overrides,
  };
}

function emptyMetrics(): ScrapeOutput["metrics"] {
  return {
    started_at: OBSERVED_AT,
    finished_at: OBSERVED_AT,
    duration_ms: 0,
    requests_made: 0,
    requests_failed: 0,
    requests_retried: 0,
    bytes_received: 0,
  };
}

const dbs: Database[] = [];
afterEach(() => {
  for (const d of dbs) d.close();
  dbs.length = 0;
});

describe("classifyJob", () => {
  it("populates level and level_rank from the title when level is null", () => {
    const j = classifyJob(makeJob({ title: "Staff Software Engineer" }));
    expect(j.level).toBe("staff");
    expect(j.level_rank).toBe(5);
  });

  it("preserves an explicit level set by the parser", () => {
    const j = classifyJob(makeJob({ title: "Staff Engineer", level: "principal", level_rank: 6 }));
    expect(j.level).toBe("principal");
    expect(j.level_rank).toBe(6);
  });

  it("flips is_recruiter_post when the title screams recruiter", () => {
    const j = classifyJob(makeJob({ title: "Talent Acquisition Partner" }));
    expect(j.is_recruiter_post).toBe(true);
  });
});

describe("buildDb", () => {
  it("emits a SQLite database with jobs, tenants, crawls, and FTS5", () => {
    const out: ScrapeOutput = {
      ats: "greenhouse",
      jobs: [
        makeJob({ title: "Senior Engineer" }),
        makeJob({ source_id: "2", title: "Recruiter", url: "https://example.com/2" }),
      ],
      tenant_results: [],
      metrics: emptyMetrics(),
    };
    const tenants: Tenant[] = [
      {
        ats: "greenhouse",
        slug: "stripe",
        display_name: "Stripe",
        status: "live",
        last_probed_at: OBSERVED_AT,
      },
    ];
    const { db, manifest } = buildDb({
      outputs: [out],
      tenants,
      buildShortSha: "abcdef1",
      builtAt: OBSERVED_AT,
    });
    dbs.push(db);

    const jobsCount = (db.query("SELECT COUNT(*) AS c FROM jobs").get() as { c: number }).c;
    expect(jobsCount).toBe(2);
    expect(manifest.total_rows).toBe(2);
    expect(manifest.ats_counts.greenhouse).toBe(2);
    expect(manifest.tenants_live).toBe(1);

    const ftsCount = (db.query("SELECT COUNT(*) AS c FROM jobs_fts").get() as { c: number }).c;
    expect(ftsCount).toBe(2);

    const ftsHit = db
      .query(
        "SELECT title FROM jobs WHERE rowid IN (SELECT rowid FROM jobs_fts WHERE jobs_fts MATCH ?)",
      )
      .all("recruiter") as Array<{ title: string }>;
    expect(ftsHit.map((r) => r.title)).toContain("Recruiter");
  });

  it("classifies jobs at insert time (level + recruiter)", () => {
    const out: ScrapeOutput = {
      ats: "greenhouse",
      jobs: [makeJob({ title: "Staff Software Engineer" })],
      tenant_results: [],
      metrics: emptyMetrics(),
    };
    const { db } = buildDb({
      outputs: [out],
      tenants: [],
      buildShortSha: "abcdef1",
      builtAt: OBSERVED_AT,
    });
    dbs.push(db);
    const row = db.query("SELECT level, level_rank FROM jobs").get() as {
      level: string;
      level_rank: number;
    };
    expect(row.level).toBe("staff");
    expect(row.level_rank).toBe(5);
  });

  it("dedupes jobs by url within a single build", () => {
    const a = makeJob({ source_id: "1", url: "https://example.com/1" });
    const b = makeJob({ source_id: "2", url: "https://example.com/1" });
    const out: ScrapeOutput = {
      ats: "greenhouse",
      jobs: [a, b],
      tenant_results: [],
      metrics: emptyMetrics(),
    };
    const { db, manifest } = buildDb({
      outputs: [out],
      tenants: [],
      buildShortSha: "abcdef1",
      builtAt: OBSERVED_AT,
    });
    dbs.push(db);
    expect(manifest.total_rows).toBe(1);
  });

  it("counts tenants_live only for status=live tenants", () => {
    const tenants: Tenant[] = [
      { ats: "greenhouse", slug: "a", status: "live", last_probed_at: OBSERVED_AT },
      { ats: "greenhouse", slug: "b", status: "dead", last_probed_at: OBSERVED_AT },
      { ats: "lever", slug: "c", status: "transient_failure", last_probed_at: OBSERVED_AT },
    ];
    const { db, manifest } = buildDb({
      outputs: [],
      tenants,
      buildShortSha: "abcdef1",
      builtAt: OBSERVED_AT,
    });
    dbs.push(db);
    expect(manifest.tenants_total).toBe(3);
    expect(manifest.tenants_live).toBe(1);
  });

  it("records the build into the crawls table", () => {
    const { db } = buildDb({
      outputs: [],
      tenants: [],
      buildShortSha: "abcdef1",
      builtAt: OBSERVED_AT,
      notes: "smoke build",
    });
    dbs.push(db);
    const row = db.query("SELECT build_short_sha, total_rows, notes FROM crawls").get() as {
      build_short_sha: string;
      total_rows: number;
      notes: string | null;
    };
    expect(row.build_short_sha).toBe("abcdef1");
    expect(row.total_rows).toBe(0);
    expect(row.notes).toBe("smoke build");
  });

  it("uses page_size = 1024 (matching sql.js-httpvfs requestChunkSize)", () => {
    const { db } = buildDb({
      outputs: [],
      tenants: [],
      buildShortSha: "abcdef1",
      builtAt: OBSERVED_AT,
    });
    dbs.push(db);
    const row = db.query("PRAGMA page_size").get() as { page_size: number };
    expect(row.page_size).toBe(1024);
  });

  it("creates the indexes the spec lists", () => {
    const { db } = buildDb({
      outputs: [],
      tenants: [],
      buildShortSha: "abcdef1",
      builtAt: OBSERVED_AT,
    });
    dbs.push(db);
    const indexes = (
      db
        .query("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'")
        .all() as Array<{
        name: string;
      }>
    ).map((r) => r.name);
    expect(indexes).toContain("idx_jobs_ats_posted_at");
    expect(indexes).toContain("idx_jobs_level_ats");
    expect(indexes).toContain("idx_jobs_level_rank");
    expect(indexes).toContain("idx_jobs_workplace_type");
    expect(indexes).toContain("idx_jobs_tenant");
    expect(indexes).toContain("idx_jobs_first_seen_at");
    expect(indexes).toContain("idx_jobs_country_region");
  });

  it("FTS update trigger reflects new title and drops the old term", () => {
    const out: ScrapeOutput = {
      ats: "greenhouse",
      jobs: [makeJob({ title: "Senior Frontend Engineer" })],
      tenant_results: [],
      metrics: emptyMetrics(),
    };
    const { db } = buildDb({
      outputs: [out],
      tenants: [],
      buildShortSha: "abcdef1",
      builtAt: OBSERVED_AT,
    });
    dbs.push(db);
    db.exec("UPDATE jobs SET title = 'Backend Wizard' WHERE source_id = '1'");
    const newHit = (
      db.query("SELECT COUNT(*) AS c FROM jobs_fts WHERE jobs_fts MATCH ?").get("wizard") as {
        c: number;
      }
    ).c;
    const oldHit = (
      db.query("SELECT COUNT(*) AS c FROM jobs_fts WHERE jobs_fts MATCH ?").get("frontend") as {
        c: number;
      }
    ).c;
    expect(newHit).toBe(1);
    expect(oldHit).toBe(0);
  });

  it("dedupes tenants by (ats, slug); manifest counts the deduped totals", () => {
    const tenants: Tenant[] = [
      { ats: "greenhouse", slug: "a", status: "live", last_probed_at: OBSERVED_AT },
      { ats: "greenhouse", slug: "a", status: "live", last_probed_at: OBSERVED_AT },
      { ats: "greenhouse", slug: "b", status: "dead", last_probed_at: OBSERVED_AT },
    ];
    const { db, manifest } = buildDb({
      outputs: [],
      tenants,
      buildShortSha: "abcdef1",
      builtAt: OBSERVED_AT,
    });
    dbs.push(db);
    expect(manifest.tenants_total).toBe(2);
    expect(manifest.tenants_live).toBe(1);
  });

  it("manifest invariants hold across arbitrary job lists", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            ats: fc.constantFrom(...ATS_IDS),
            sid: fc.string({ minLength: 1, maxLength: 8 }).filter((s) => /^[a-z0-9-]+$/i.test(s)),
            host: fc.string({ minLength: 4, maxLength: 12 }).filter((s) => /^[a-z0-9-]+$/i.test(s)),
          }),
          { maxLength: 12 },
        ),
        (rows) => {
          const jobs = rows.map((r) =>
            makeJob({
              ats: r.ats,
              source_id: r.sid,
              url: `https://example.com/${r.host}/${r.sid}`,
            }),
          );
          const out: ScrapeOutput = {
            ats: "greenhouse",
            jobs,
            tenant_results: [],
            metrics: emptyMetrics(),
          };
          const { db, manifest } = buildDb({
            outputs: [out],
            tenants: [],
            buildShortSha: "abcdef1",
            builtAt: OBSERVED_AT,
          });
          dbs.push(db);
          const sumAtsCounts = ATS_IDS.reduce((acc, id) => acc + manifest.ats_counts[id], 0);
          return manifest.total_rows === sumAtsCounts;
        },
      ),
      { numRuns: 30 },
    );
  });

  it("FTS triggers keep jobs_fts in sync after delete", () => {
    const out: ScrapeOutput = {
      ats: "greenhouse",
      jobs: [makeJob({ title: "Senior Engineer" })],
      tenant_results: [],
      metrics: emptyMetrics(),
    };
    const { db } = buildDb({
      outputs: [out],
      tenants: [],
      buildShortSha: "abcdef1",
      builtAt: OBSERVED_AT,
    });
    dbs.push(db);
    db.exec("DELETE FROM jobs");
    const ftsCount = (db.query("SELECT COUNT(*) AS c FROM jobs_fts").get() as { c: number }).c;
    expect(ftsCount).toBe(0);
  });
});
