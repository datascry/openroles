import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PAGE_SIZE_PRAGMA, SCHEMA_DDL } from "../../scraper/src/db/schema.ts";
import { GET as getAtsFeed, getStaticPaths as getAtsPaths } from "../src/pages/feed/[ats].xml.ts";
import {
  GET as getLevelFeed,
  getStaticPaths as getLevelPaths,
} from "../src/pages/feed/level/[level].xml.ts";
import { GET as getFullFeed } from "../src/pages/feed.xml.ts";

const OBSERVED_AT = "2026-04-26T00:00:00Z";

function makeContext(params: Record<string, string | undefined> = {}): any {
  return {
    params,
    site: new URL("https://example.test/"),
    request: new Request("https://example.test/"),
    locals: {},
  };
}

function makeDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "openroles-site-"));
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
  return dir;
}

const originalDataDir = process.env["OPENROLES_DATA_DIR"];
afterEach(() => {
  if (originalDataDir === undefined) delete process.env["OPENROLES_DATA_DIR"];
  else process.env["OPENROLES_DATA_DIR"] = originalDataDir;
});

describe("feed.xml endpoints", () => {
  it("/feed.xml returns 503 when data dir is unpopulated", async () => {
    process.env["OPENROLES_DATA_DIR"] = "/tmp/openroles-no-data-xyz";
    const res = await (getFullFeed(makeContext()) as Response | Promise<Response>);
    expect(res.status).toBe(503);
  });

  it("/feed.xml returns RSS when data is built", async () => {
    process.env["OPENROLES_DATA_DIR"] = makeDataDir();
    const res = await (getFullFeed(makeContext()) as Response | Promise<Response>);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/rss+xml; charset=utf-8");
  });

  it("/feed/[ats].xml returns 404 for unknown ats", async () => {
    process.env["OPENROLES_DATA_DIR"] = makeDataDir();
    const res = await (getAtsFeed(makeContext({ ats: "rippling" })) as
      | Response
      | Promise<Response>);
    expect(res.status).toBe(404);
  });

  it("/feed/[ats].xml returns 503 when data is missing", async () => {
    process.env["OPENROLES_DATA_DIR"] = "/tmp/openroles-no-data-xyz";
    const res = await (getAtsFeed(makeContext({ ats: "greenhouse" })) as
      | Response
      | Promise<Response>);
    expect(res.status).toBe(503);
  });

  it("/feed/[ats].xml returns RSS for a known ats", async () => {
    process.env["OPENROLES_DATA_DIR"] = makeDataDir();
    const res = await (getAtsFeed(makeContext({ ats: "greenhouse" })) as
      | Response
      | Promise<Response>);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/rss+xml; charset=utf-8");
  });

  it("/feed/level/[level].xml returns 404 for unknown level", async () => {
    process.env["OPENROLES_DATA_DIR"] = makeDataDir();
    const res = await (getLevelFeed(makeContext({ level: "architect" })) as
      | Response
      | Promise<Response>);
    expect(res.status).toBe(404);
  });

  it("/feed/level/[level].xml returns 503 when data is missing", async () => {
    process.env["OPENROLES_DATA_DIR"] = "/tmp/openroles-no-data-xyz";
    const res = await (getLevelFeed(makeContext({ level: "senior" })) as
      | Response
      | Promise<Response>);
    expect(res.status).toBe(503);
  });

  it("/feed/level/[level].xml returns RSS for a known level", async () => {
    process.env["OPENROLES_DATA_DIR"] = makeDataDir();
    const res = await (getLevelFeed(makeContext({ level: "senior" })) as
      | Response
      | Promise<Response>);
    expect(res.status).toBe(200);
  });

  it("getStaticPaths emits one entry per ATS in canonical order", async () => {
    const { ATS_IDS } = await import("@openroles/shared");
    const paths = (getAtsPaths as () => Array<{ params: { ats: string } }>)();
    const ats = paths.map((p) => p.params.ats);
    // Build-time path order matches ATS_IDS canonical order; future-proofs
    // against schema widening.
    expect(ats).toEqual([...ATS_IDS]);
  });

  it("getStaticPaths for level emits one entry per non-null level", () => {
    const paths = (getLevelPaths as () => Array<{ params: { level: string } }>)();
    expect(paths.length).toBe(10);
    expect(paths.every((p) => typeof p.params.level === "string")).toBe(true);
  });
});
