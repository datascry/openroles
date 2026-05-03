import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { INDEX_DDL, PAGE_SIZE_PRAGMA, SCHEMA_DDL } from "./schema.ts";
import { emitSearchIndex, stem } from "./search-index.ts";

interface SeedRow {
  readonly id: string;
  readonly title: string;
  readonly company: string;
  readonly posted_at?: string | null;
  readonly first_seen_at?: string;
}

function makeDb(rows: ReadonlyArray<SeedRow>): { db: Database; outputDir: string } {
  const outputDir = mkdtempSync(join(tmpdir(), "search-idx-test-"));
  const dbPath = join(outputDir, "jobs.sqlite");
  const db = new Database(dbPath);
  db.exec(PAGE_SIZE_PRAGMA);
  db.exec(SCHEMA_DDL);
  db.exec(INDEX_DDL);
  const insert = db.prepare(`
    INSERT INTO jobs (
      id, ats, tenant_slug, source_id, title, company,
      first_seen_at, last_seen_at, url
    ) VALUES (?, 'greenhouse', 'stripe', ?, ?, ?, ?, ?, ?)
  `);
  for (const r of rows) {
    insert.run(
      r.id,
      r.id, // source_id
      r.title,
      r.company,
      r.first_seen_at ?? "2026-04-25T00:00:00Z",
      "2026-04-25T00:00:00Z",
      `https://example.com/${r.id}`,
    );
    if (r.posted_at !== undefined) {
      db.run("UPDATE jobs SET posted_at = ? WHERE id = ?", [r.posted_at, r.id]);
    }
  }
  return { db, outputDir };
}

function readPayload(
  outputDir: string,
  file: string,
): {
  v: string;
  n: number;
  stems: Record<string, string>;
} {
  const path = join(outputDir, file);
  const gz = readFileSync(path);
  const raw = gunzipSync(gz);
  return JSON.parse(raw.toString("utf-8"));
}

describe("stem (build-side)", () => {
  it("collapses engineer family", () => {
    expect(stem("engineer")).toBe(stem("engineering"));
    expect(stem("engineer")).toBe(stem("engineered"));
  });

  it("leaves senior alone (no -or rule)", () => {
    expect(stem("senior")).toBe("senior");
    expect(stem("junior")).toBe("junior");
  });

  it("plural collapse", () => {
    expect(stem("designs")).toBe(stem("design"));
  });
});

describe("emitSearchIndex", () => {
  it("emits a parseable gzipped payload with the expected schema version", async () => {
    const rows: SeedRow[] = [
      {
        id: "0".repeat(64),
        title: "Senior Engineer",
        company: "Stripe",
        posted_at: "2026-04-25T00:00:00Z",
      },
    ];
    const { db, outputDir } = makeDb(rows);
    try {
      const result = await emitSearchIndex(db, { outputDir });
      expect(result.fields.search_index_schema_version).toBe("1.0");
      expect(result.fields.search_index_total_rows).toBe(1);
      expect(result.fields.search_index_filename).toBe("search/title-tokens.json.gz");
      expect(result.fields.search_index_bytes_gz).toBeGreaterThan(0);
      const payload = readPayload(outputDir, result.fields.search_index_filename);
      expect(payload.v).toBe("1.0");
      expect(payload.n).toBe(1);
    } finally {
      db.close();
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it("indexes title and company tokens, drops stop words", async () => {
    const rows: SeedRow[] = [
      {
        id: "1".padEnd(64, "0"),
        title: "Senior Engineer at the Foundry",
        company: "Stripe",
        posted_at: "2026-04-25T00:00:00Z",
      },
    ];
    const { db, outputDir } = makeDb(rows);
    try {
      const result = await emitSearchIndex(db, { outputDir });
      const payload = readPayload(outputDir, result.fields.search_index_filename);
      // "the" / "at" are stop words → must not appear.
      expect(payload.stems).not.toHaveProperty("the");
      expect(payload.stems).not.toHaveProperty("at");
      // Engineer → engin, Senior → senior (no -or rule), Stripe → strip (-e drop).
      expect(payload.stems).toHaveProperty("engin");
      expect(payload.stems).toHaveProperty("senior");
      expect(payload.stems).toHaveProperty("strip");
    } finally {
      db.close();
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it("sorts rows by posted_at DESC NULLS LAST so postings line up with slim-index order", async () => {
    const rows: SeedRow[] = [
      {
        id: "a".repeat(64),
        title: "Older role",
        company: "Co",
        posted_at: "2026-04-20T00:00:00Z",
      },
      {
        id: "b".repeat(64),
        title: "Newer role",
        company: "Co",
        posted_at: "2026-04-25T00:00:00Z",
      },
      {
        id: "c".repeat(64),
        title: "Undated role",
        company: "Co",
        posted_at: null,
      },
    ];
    const { db, outputDir } = makeDb(rows);
    try {
      const result = await emitSearchIndex(db, { outputDir });
      const payload = readPayload(outputDir, result.fields.search_index_filename);
      // posted_at DESC NULLS LAST → newer (idx 0), older (idx 1), undated (idx 2)
      // newer → "new" (-er stripped), older → "old", undated → "undat" (-ed stripped)
      expect(payload.stems["new"]).toBe("0");
      expect(payload.stems["old"]).toBe("1");
      expect(payload.stems["undat"]).toBe("2");
    } finally {
      db.close();
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it("delta-encodes posting lists in base-36", async () => {
    // Three rows that all contain "engineer" — postings should be [0, 1, 2]
    // delta-encoded as "0,1,1".
    const rows: SeedRow[] = Array.from({ length: 3 }, (_, i) => ({
      id: i.toString(16).padStart(64, "0"),
      title: "Engineer",
      company: `Co${i}`,
      posted_at: `2026-04-${String(20 + i).padStart(2, "0")}T00:00:00Z`,
    }));
    const { db, outputDir } = makeDb(rows);
    try {
      const result = await emitSearchIndex(db, { outputDir });
      const payload = readPayload(outputDir, result.fields.search_index_filename);
      // posted_at DESC: row idx 2 (newest), 1, 0. All three contain engineer.
      expect(payload.stems["engin"]).toBe("0,1,1");
      expect(result.fields.search_index_unique_stems).toBeGreaterThan(1);
      expect(result.fields.search_index_total_postings).toBeGreaterThanOrEqual(3);
    } finally {
      db.close();
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it("strips diacritics so accented variants normalise", async () => {
    const rows: SeedRow[] = [
      {
        id: "f".repeat(64),
        title: "Café Manager",
        company: "Résumé Co",
        posted_at: "2026-04-25T00:00:00Z",
      },
    ];
    const { db, outputDir } = makeDb(rows);
    try {
      const result = await emitSearchIndex(db, { outputDir });
      const payload = readPayload(outputDir, result.fields.search_index_filename);
      // "cafe", "manag" (manager → manag), "resume", "co"
      expect(payload.stems).toHaveProperty("cafe");
      expect(payload.stems).toHaveProperty("resum"); // resume → resum (-e drop)
      expect(payload.stems).toHaveProperty("manag");
    } finally {
      db.close();
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it("emits zero stems for an empty jobs table", async () => {
    const { db, outputDir } = makeDb([]);
    try {
      const result = await emitSearchIndex(db, { outputDir });
      expect(result.fields.search_index_total_rows).toBe(0);
      expect(result.fields.search_index_unique_stems).toBe(0);
      expect(result.fields.search_index_total_postings).toBe(0);
    } finally {
      db.close();
      rmSync(outputDir, { recursive: true, force: true });
    }
  });
});
