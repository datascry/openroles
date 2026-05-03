import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { INDEX_DDL, PAGE_SIZE_PRAGMA, SCHEMA_DDL } from "./schema.ts";
import { emitSlimIndex } from "./slim-index.ts";

interface SeedRow {
  readonly id: string;
  readonly ats: string;
  readonly tenant_slug: string;
  readonly source_id: string;
  readonly title: string;
  readonly company: string;
  readonly description_excerpt?: string | null;
  readonly level?: string | null;
  readonly level_rank?: number | null;
  readonly workplace_type?: string | null;
  readonly is_recruiter_post?: number;
  readonly location_text?: string | null;
  readonly location_country?: string | null;
  readonly location_region?: string | null;
  readonly compensation_min?: number | null;
  readonly compensation_max?: number | null;
  readonly compensation_currency?: string | null;
  readonly department?: string | null;
  readonly posted_at?: string | null;
  readonly updated_at?: string | null;
  readonly first_seen_at: string;
  readonly last_seen_at: string;
  readonly is_stale?: number;
  readonly url: string;
}

function makeDb(rows: ReadonlyArray<SeedRow>): { db: Database; outputDir: string } {
  const outputDir = mkdtempSync(join(tmpdir(), "slim-index-test-"));
  const dbPath = join(outputDir, "jobs.sqlite");
  const db = new Database(dbPath);
  db.exec(PAGE_SIZE_PRAGMA);
  db.exec(SCHEMA_DDL);
  db.exec(INDEX_DDL);
  const insert = db.prepare<unknown[], [SeedRow]>(`
    INSERT INTO jobs (
      id, ats, tenant_slug, source_id, title, company, description_excerpt,
      level, level_rank, workplace_type, is_recruiter_post,
      location_text, location_country, location_region,
      compensation_min, compensation_max, compensation_currency,
      department, posted_at, updated_at,
      first_seen_at, last_seen_at, is_stale, url
    ) VALUES (
      $id, $ats, $tenant_slug, $source_id, $title, $company, $description_excerpt,
      $level, $level_rank, $workplace_type, $is_recruiter_post,
      $location_text, $location_country, $location_region,
      $compensation_min, $compensation_max, $compensation_currency,
      $department, $posted_at, $updated_at,
      $first_seen_at, $last_seen_at, $is_stale, $url
    )
  `);
  for (const r of rows) {
    insert.run({
      $id: r.id,
      $ats: r.ats,
      $tenant_slug: r.tenant_slug,
      $source_id: r.source_id,
      $title: r.title,
      $company: r.company,
      $description_excerpt: r.description_excerpt ?? null,
      $level: r.level ?? null,
      $level_rank: r.level_rank ?? null,
      $workplace_type: r.workplace_type ?? null,
      $is_recruiter_post: r.is_recruiter_post ?? 0,
      $location_text: r.location_text ?? null,
      $location_country: r.location_country ?? null,
      $location_region: r.location_region ?? null,
      $compensation_min: r.compensation_min ?? null,
      $compensation_max: r.compensation_max ?? null,
      $compensation_currency: r.compensation_currency ?? null,
      $department: r.department ?? null,
      $posted_at: r.posted_at ?? null,
      $updated_at: r.updated_at ?? null,
      $first_seen_at: r.first_seen_at,
      $last_seen_at: r.last_seen_at,
      $is_stale: r.is_stale ?? 0,
      $url: r.url,
    });
  }
  return { db, outputDir };
}

function readChunk(outputDir: string, file: string): unknown[] {
  const path = join(outputDir, file);
  const gz = readFileSync(path);
  const raw = gunzipSync(gz);
  return JSON.parse(raw.toString("utf-8")) as unknown[];
}

const SEED_BASE: SeedRow = {
  id: "0".repeat(64),
  ats: "greenhouse",
  tenant_slug: "stripe",
  source_id: "abc",
  title: "Engineer",
  company: "Stripe",
  first_seen_at: "2026-05-01T00:00:00Z",
  last_seen_at: "2026-05-03T00:00:00Z",
  url: "https://example.com/job",
};

describe("emitSlimIndex", () => {
  it("emits one chunk for a small dataset and records correct manifest fields", async () => {
    const rows: SeedRow[] = [
      {
        ...SEED_BASE,
        id: "a".repeat(64),
        title: "Senior Engineer",
        posted_at: "2026-05-02T10:00:00Z",
      },
      {
        ...SEED_BASE,
        id: "b".repeat(64),
        url: "https://example.com/job/b",
        title: "Junior Engineer",
        posted_at: "2026-05-01T10:00:00Z",
      },
    ];
    const { db, outputDir } = makeDb(rows);
    try {
      const result = await emitSlimIndex(db, { outputDir });
      expect(result.fields.slim_index_total_rows).toBe(2);
      expect(result.fields.slim_index_chunks).toHaveLength(1);
      expect(result.fields.slim_index_schema_version).toBe("1.0");
      const entry = result.fields.slim_index_chunks[0];
      expect(entry).toBeDefined();
      if (!entry) return;
      expect(entry.rows).toBe(2);
      expect(entry.bytes_gz).toBeGreaterThan(0);
      expect(entry.bytes_raw).toBeGreaterThan(entry.bytes_gz);
      expect(entry.posted_min).toBe("2026-05-01T10:00:00Z");
      expect(entry.posted_max).toBe("2026-05-02T10:00:00Z");
      expect(entry.has_null_posted).toBe(false);

      const chunk = readChunk(outputDir, entry.file) as Array<Record<string, unknown>>;
      // Sorted newest-first: senior (2026-05-02) before junior (2026-05-01).
      expect(chunk[0]?.["ti"]).toBe("Senior Engineer");
      expect(chunk[1]?.["ti"]).toBe("Junior Engineer");
      // Short id is the first 16 hex chars of the full id.
      expect(chunk[0]?.["i"]).toBe("a".repeat(16));
      // No url / description leaked into the slim payload.
      expect(chunk[0]).not.toHaveProperty("url");
      expect(chunk[0]).not.toHaveProperty("description_excerpt");
    } finally {
      db.close();
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it("splits across multiple chunks when rowsPerChunk exceeded", async () => {
    const rows: SeedRow[] = Array.from({ length: 5 }, (_, i) => ({
      ...SEED_BASE,
      id: i.toString(16).padStart(64, "0"),
      url: `https://example.com/job/${i}`,
      title: `Role ${i}`,
      posted_at: `2026-05-0${5 - i}T00:00:00Z`,
    }));
    const { db, outputDir } = makeDb(rows);
    try {
      const result = await emitSlimIndex(db, { outputDir, rowsPerChunk: 2 });
      expect(result.fields.slim_index_chunks).toHaveLength(3);
      const counts = result.fields.slim_index_chunks.map((c) => c.rows);
      expect(counts).toEqual([2, 2, 1]);
      // Each chunk's posted_max is older than the previous chunk's posted_min,
      // proving global newest-first ordering across chunks.
      const chunks = result.fields.slim_index_chunks;
      expect(chunks[0]?.posted_max ?? "").toBe("2026-05-05T00:00:00Z");
      expect(chunks[1]?.posted_max ?? "").toBe("2026-05-03T00:00:00Z");
      expect(chunks[2]?.posted_max ?? "").toBe("2026-05-01T00:00:00Z");
    } finally {
      db.close();
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it("handles rows with null posted_at (sorts them to the end)", async () => {
    const rows: SeedRow[] = [
      {
        ...SEED_BASE,
        id: "a".repeat(64),
        title: "Has date",
        posted_at: "2026-05-01T00:00:00Z",
      },
      {
        ...SEED_BASE,
        id: "b".repeat(64),
        url: "https://example.com/job/b",
        title: "No date",
        posted_at: null,
      },
    ];
    const { db, outputDir } = makeDb(rows);
    try {
      const result = await emitSlimIndex(db, { outputDir });
      const entry = result.fields.slim_index_chunks[0];
      expect(entry?.has_null_posted).toBe(true);
      // posted_min/max only consider non-null values.
      expect(entry?.posted_min).toBe("2026-05-01T00:00:00Z");
      expect(entry?.posted_max).toBe("2026-05-01T00:00:00Z");
      const chunk = readChunk(outputDir, entry?.file ?? "") as Array<Record<string, unknown>>;
      expect(chunk[0]?.["ti"]).toBe("Has date");
      expect(chunk[1]?.["ti"]).toBe("No date");
    } finally {
      db.close();
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it("filenames include a 4-digit chunk index and a 16-hex-char content sha", async () => {
    const rows: SeedRow[] = [
      {
        ...SEED_BASE,
        id: "a".repeat(64),
        posted_at: "2026-05-01T00:00:00Z",
      },
    ];
    const { db, outputDir } = makeDb(rows);
    try {
      const result = await emitSlimIndex(db, { outputDir });
      const entry = result.fields.slim_index_chunks[0];
      expect(entry?.file).toMatch(/^slim\/slim-0000-[0-9a-f]{16}\.json\.gz$/);
    } finally {
      db.close();
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it("rejects rowsPerChunk < 1", async () => {
    const { db, outputDir } = makeDb([]);
    try {
      await expect(emitSlimIndex(db, { outputDir, rowsPerChunk: 0 })).rejects.toThrow(
        /rowsPerChunk must be >= 1/,
      );
    } finally {
      db.close();
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it("emits zero chunks for an empty jobs table", async () => {
    const { db, outputDir } = makeDb([]);
    try {
      const result = await emitSlimIndex(db, { outputDir });
      expect(result.fields.slim_index_total_rows).toBe(0);
      expect(result.fields.slim_index_chunks).toHaveLength(0);
      expect(result.chunkPaths).toHaveLength(0);
    } finally {
      db.close();
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it("preserves all slim columns in the on-wire format", async () => {
    const rows: SeedRow[] = [
      {
        ...SEED_BASE,
        id: "f".repeat(64),
        ats: "lever",
        tenant_slug: "linear",
        title: "Staff Eng",
        company: "Linear",
        level: "staff",
        level_rank: 5,
        workplace_type: "remote",
        is_recruiter_post: 1,
        is_stale: 0,
        location_text: "Remote · NA",
        location_country: "US",
        compensation_min: 200000,
        compensation_max: 250000,
        compensation_currency: "USD",
        posted_at: "2026-05-01T00:00:00Z",
      },
    ];
    const { db, outputDir } = makeDb(rows);
    try {
      const result = await emitSlimIndex(db, { outputDir });
      const entry = result.fields.slim_index_chunks[0];
      const chunk = readChunk(outputDir, entry?.file ?? "") as Array<Record<string, unknown>>;
      const r0 = chunk[0];
      expect(r0).toBeDefined();
      if (!r0) return;
      expect(r0["i"]).toBe("f".repeat(16));
      expect(r0["a"]).toBe("lever");
      expect(r0["t"]).toBe("linear");
      expect(r0["ti"]).toBe("Staff Eng");
      expect(r0["c"]).toBe("Linear");
      expect(r0["l"]).toBe("staff");
      expect(r0["w"]).toBe("remote");
      expect(r0["r"]).toBe(1);
      expect(r0["s"]).toBe(0);
      expect(r0["loc"]).toBe("Remote · NA");
      expect(r0["cc"]).toBe("US");
      expect(r0["p"]).toBe("2026-05-01T00:00:00Z");
      expect(r0["cm"]).toBe(200000);
      expect(r0["cmax"]).toBe(250000);
      expect(r0["cur"]).toBe("USD");
    } finally {
      db.close();
      rmSync(outputDir, { recursive: true, force: true });
    }
  });
});
