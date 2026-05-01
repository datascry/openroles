import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ATS_IDS, type Job, jobId, type ScrapeOutput, type Tenant } from "@openroles/shared";
import fc from "fast-check";
import { buildDb, classifyJob, daysSinceUtc, planCarryForward } from "./build-db.ts";

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

  it("fills workplace_type from the title when the adapter left it null", () => {
    const j = classifyJob(makeJob({ title: "Remote Software Engineer", workplace_type: null }));
    expect(j.workplace_type).toBe("remote");
  });

  it("preserves an explicit workplace_type set by the adapter", () => {
    const j = classifyJob(makeJob({ title: "Software Engineer", workplace_type: "hybrid" }));
    expect(j.workplace_type).toBe("hybrid");
  });

  it("falls back to location_text when title is silent on workplace", () => {
    const j = classifyJob(
      makeJob({
        title: "Software Engineer",
        location_text: "Remote (US)",
        workplace_type: null,
      }),
    );
    expect(j.workplace_type).toBe("remote");
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

// ---------- Phase 12 — role lifecycle ----------

describe("daysSinceUtc", () => {
  it("returns 0 when timestamps are equal", () => {
    expect(daysSinceUtc("2026-04-26T00:00:00Z", "2026-04-26T00:00:00Z")).toBe(0);
  });
  it("returns 0 when 'then' is in the future", () => {
    expect(daysSinceUtc("2026-04-25T00:00:00Z", "2026-04-26T00:00:00Z")).toBe(0);
  });
  it("counts whole UTC-day boundaries, not literal 24-hour spans", () => {
    // 23:59 → next day 00:01 crosses a UTC-day boundary even though the
    // literal span is < 1 hour.
    expect(daysSinceUtc("2026-04-26T00:01:00Z", "2026-04-25T23:59:00Z")).toBe(1);
  });
  it("returns 0 for sub-day spans within the same UTC day", () => {
    expect(daysSinceUtc("2026-04-26T23:59:59Z", "2026-04-26T00:00:00Z")).toBe(0);
  });
  it("returns floor((nowDay - thenDay)) for multi-day spans", () => {
    expect(daysSinceUtc("2026-04-30T00:00:00Z", "2026-04-26T00:00:00Z")).toBe(4);
  });
  it("returns 0 on invalid input rather than NaN propagating", () => {
    expect(daysSinceUtc("not-a-date", "2026-04-26T00:00:00Z")).toBe(0);
    expect(daysSinceUtc("2026-04-26T00:00:00Z", "not-a-date")).toBe(0);
  });
});

describe("planCarryForward", () => {
  function row(id: string, lastSeenAt: string, url = `https://example.com/${id}`) {
    return {
      id,
      ats: "greenhouse",
      tenant_slug: "stripe",
      source_id: id,
      title: "Senior Engineer",
      company: "Stripe",
      description_excerpt: null,
      level: null,
      level_rank: null,
      workplace_type: null,
      is_recruiter_post: 0,
      location_text: null,
      location_country: null,
      location_region: null,
      compensation_min: null,
      compensation_max: null,
      compensation_currency: null,
      department: null,
      posted_at: null,
      updated_at: null,
      first_seen_at: lastSeenAt,
      last_seen_at: lastSeenAt,
      url,
    };
  }

  it("rejects ttlDays < 1", () => {
    expect(() => planCarryForward([], new Set(), new Set(), OBSERVED_AT, 0)).toThrow();
  });

  it("returns empty when there are no previous rows", () => {
    const result = planCarryForward([], new Set(["abc"]), new Set(), OBSERVED_AT, 3);
    expect(result.carried).toEqual([]);
    expect(result.dropped).toBe(0);
  });

  it("does not carry forward rows whose id is in today's fresh set", () => {
    const prev = [row("a", "2026-04-25T00:00:00Z")];
    const result = planCarryForward(prev, new Set(["a"]), new Set(), OBSERVED_AT, 3);
    expect(result.carried).toEqual([]);
    expect(result.dropped).toBe(0); // not dropped — today's fresh row replaces it
  });

  it("does not carry forward rows whose URL collides with a fresh row's URL", () => {
    const prev = [row("a", "2026-04-25T00:00:00Z", "https://example.com/x")];
    const result = planCarryForward(
      prev,
      new Set(["b"]),
      new Set(["https://example.com/x"]),
      OBSERVED_AT,
      3,
    );
    expect(result.carried).toEqual([]);
  });

  it("carries forward rows under the TTL", () => {
    const prev = [row("a", "2026-04-25T00:00:00Z")]; // 1 day stale
    const result = planCarryForward(prev, new Set(), new Set(), OBSERVED_AT, 3);
    expect(result.carried.map((r) => r.id)).toEqual(["a"]);
    expect(result.dropped).toBe(0);
  });

  it("drops rows at or above the TTL", () => {
    const prev = [row("a", "2026-04-23T00:00:00Z")]; // 3 days stale
    const result = planCarryForward(prev, new Set(), new Set(), OBSERVED_AT, 3);
    expect(result.carried).toEqual([]);
    expect(result.dropped).toBe(1);
  });

  describe("invariants (fast-check)", () => {
    const NOW = new Date("2026-04-30T00:00:00Z").getTime();
    const arbRow = fc
      .integer({ min: 0, max: 30 })
      .map((daysAgo) =>
        row("id" + daysAgo, new Date(NOW - daysAgo * 86_400_000).toISOString(), "u" + daysAgo),
      );

    it("every emitted row is below the TTL threshold; every dropped row is at or above it", () => {
      fc.assert(
        fc.property(
          fc.array(arbRow, { maxLength: 12 }),
          fc.integer({ min: 1, max: 14 }),
          (rows, ttl) => {
            const result = planCarryForward(
              rows,
              new Set(),
              new Set(),
              "2026-04-30T00:00:00Z",
              ttl,
            );
            for (const r of result.carried) {
              expect(daysSinceUtc("2026-04-30T00:00:00Z", r.last_seen_at)).toBeLessThan(ttl);
            }
            const carriedIds = new Set(result.carried.map((r) => r.id));
            const droppedExpected = rows.filter(
              (r) =>
                !carriedIds.has(r.id) &&
                daysSinceUtc("2026-04-30T00:00:00Z", r.last_seen_at) >= ttl,
            ).length;
            expect(result.dropped).toBe(droppedExpected);
          },
        ),
        { numRuns: 50 },
      );
    });
  });
});

describe("buildDb carry-forward integration", () => {
  let tmpDir: string;
  afterEach(() => {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it("stamps is_stale=0 on fresh rows and is_stale=1 on carried rows", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "openroles-carry-"));
    const yesterday = "2026-04-25T00:00:00Z";
    const today = "2026-04-26T00:00:00Z";

    // Day 1: build with two roles. Persist to disk so we can pass the
    // path back as the previous DB on day 2.
    const day1Path = join(tmpDir, "day1.sqlite");
    const day1 = buildDb(
      {
        outputs: [
          {
            ats: "greenhouse",
            jobs: [
              makeJob({
                source_id: "1",
                url: "https://x/1",
                first_seen_at: yesterday,
                last_seen_at: yesterday,
              }),
              makeJob({
                source_id: "2",
                url: "https://x/2",
                first_seen_at: yesterday,
                last_seen_at: yesterday,
              }),
            ],
            tenant_results: [],
            metrics: emptyMetrics(),
          },
        ],
        tenants: [],
        buildShortSha: "abcdef1",
        builtAt: yesterday,
      },
      day1Path,
    );
    day1.db.close();

    // Day 2: only role 1 is in today's scrape. Role 2 should carry forward.
    const day2Path = join(tmpDir, "day2.sqlite");
    const day2 = buildDb(
      {
        outputs: [
          {
            ats: "greenhouse",
            jobs: [
              makeJob({
                source_id: "1",
                url: "https://x/1",
                first_seen_at: today,
                last_seen_at: today,
              }),
            ],
            tenant_results: [],
            metrics: emptyMetrics(),
          },
        ],
        tenants: [],
        buildShortSha: "abcdef2",
        builtAt: today,
        previousDbPath: day1Path,
      },
      day2Path,
    );
    dbs.push(day2.db);

    const rows = day2.db
      .query("SELECT source_id, is_stale, first_seen_at, last_seen_at FROM jobs ORDER BY source_id")
      .all() as Array<{
      source_id: string;
      is_stale: number;
      first_seen_at: string;
      last_seen_at: string;
    }>;
    expect(rows).toHaveLength(2);
    expect(rows[0]?.source_id).toBe("1");
    expect(rows[0]?.is_stale).toBe(0);
    // Fresh observation preserves the original first_seen_at (carry-forward
    // semantics, even when the row was already fresh yesterday).
    expect(rows[0]?.first_seen_at).toBe(yesterday);
    expect(rows[0]?.last_seen_at).toBe(today);
    expect(rows[1]?.source_id).toBe("2");
    expect(rows[1]?.is_stale).toBe(1);
    expect(rows[1]?.last_seen_at).toBe(yesterday);

    expect(day2.manifest.fresh_count).toBe(1);
    expect(day2.manifest.stale_count).toBe(1);
    expect(day2.manifest.total_rows).toBe(2);
    expect(day2.manifest.stale_ttl_days).toBe(3);
  });

  it("drops rows once last_seen_at is older than the TTL", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "openroles-ttl-"));
    const oldDay = "2026-04-22T00:00:00Z";
    const today = "2026-04-26T00:00:00Z"; // 4 days later

    const day1Path = join(tmpDir, "old.sqlite");
    const day1 = buildDb(
      {
        outputs: [
          {
            ats: "greenhouse",
            jobs: [
              makeJob({
                source_id: "1",
                url: "https://x/1",
                first_seen_at: oldDay,
                last_seen_at: oldDay,
              }),
            ],
            tenant_results: [],
            metrics: emptyMetrics(),
          },
        ],
        tenants: [],
        buildShortSha: "abcdef1",
        builtAt: oldDay,
      },
      day1Path,
    );
    day1.db.close();

    const day2 = buildDb({
      outputs: [],
      tenants: [],
      buildShortSha: "abcdef2",
      builtAt: today,
      previousDbPath: day1Path,
      staleTtlDays: 3,
    });
    dbs.push(day2.db);

    expect(day2.manifest.total_rows).toBe(0);
    expect(day2.manifest.stale_count).toBe(0);
  });
});
