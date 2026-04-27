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
import { renderAtsFeed, renderFullFeed, renderLevelFeed } from "./feed-builder.ts";

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

const recent = "2026-04-22T00:00:00Z";

function fresh(jobs: Job[]): Database {
  const db = new Database(":memory:");
  db.exec(PAGE_SIZE_PRAGMA);
  db.exec(SCHEMA_DDL);
  db.exec(INDEX_DDL);
  const insert = db.prepare(
    "INSERT INTO jobs (id, ats, tenant_slug, source_id, title, company, level, level_rank, workplace_type, is_recruiter_post, posted_at, first_seen_at, last_seen_at, url) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
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

const ctx = {
  siteUrl: "https://datascry.github.io",
  basePath: "openroles",
};

const manifest = {
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
} as const;

describe("renderFullFeed", () => {
  it("ships RSS with the correct headers and self link", async () => {
    const db = fresh([
      makeJob({ source_id: "1", url: "https://example.com/1", posted_at: recent }),
    ]);
    const res = renderFullFeed({ db, manifest, close: () => db.close() }, ctx);
    expect(res.headers.get("content-type")).toBe("application/rss+xml; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
    const body = await res.text();
    expect(body).toContain('<atom:link href="https://datascry.github.io/openroles/feed.xml"');
    expect((body.match(/<item>/g) ?? []).length).toBe(1);
  });
});

describe("renderAtsFeed", () => {
  it("filters by ats and renders self link with the ats name", async () => {
    const db = fresh([
      makeJob({
        source_id: "1",
        url: "https://example.com/1",
        ats: "greenhouse",
        posted_at: recent,
      }),
      makeJob({ source_id: "2", url: "https://example.com/2", ats: "lever", posted_at: recent }),
    ]);
    const res = renderAtsFeed({ db, manifest, close: () => db.close() }, "greenhouse", ctx);
    const body = await res.text();
    expect(body).toContain("openroles — greenhouse");
    expect(body).toContain("/feed/greenhouse.xml");
    expect((body.match(/<item>/g) ?? []).length).toBe(1);
  });
});

describe("renderLevelFeed", () => {
  it("filters by level and renders self link with the level name", async () => {
    const db = fresh([
      makeJob({
        source_id: "1",
        url: "https://example.com/1",
        level: "senior",
        level_rank: 4,
        posted_at: recent,
      }),
      makeJob({
        source_id: "2",
        url: "https://example.com/2",
        level: "junior",
        level_rank: 2,
        posted_at: recent,
      }),
    ]);
    const res = renderLevelFeed({ db, manifest, close: () => db.close() }, "senior", ctx);
    const body = await res.text();
    expect(body).toContain("openroles — senior level");
    expect(body).toContain("/feed/level/senior.xml");
    expect((body.match(/<item>/g) ?? []).length).toBe(1);
  });
});

describe("URL building edge cases", () => {
  it("handles a site URL with a trailing slash and no basePath", async () => {
    const db = fresh([
      makeJob({ source_id: "1", url: "https://example.com/1", posted_at: recent }),
    ]);
    const res = renderFullFeed(
      { db, manifest, close: () => db.close() },
      {
        siteUrl: "https://example.com/",
        basePath: "",
      },
    );
    const body = await res.text();
    expect(body).toContain('href="https://example.com/feed.xml"');
    expect(body).not.toContain("//feed.xml");
  });

  it("emits a non-empty <link> with the canonical site URL", async () => {
    const db = fresh([]);
    const res = renderFullFeed({ db, manifest, close: () => db.close() }, ctx);
    const body = await res.text();
    const m = body.match(/<link>([^<]+)<\/link>/);
    expect(m?.[1]).toBe("https://datascry.github.io/openroles");
    expect(body).not.toContain("//<");
  });
});
